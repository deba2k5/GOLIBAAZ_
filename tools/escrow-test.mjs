/**
 * Escrow rules test: runs the relay with a fake payment layer (no chain, no money) and plays
 * two clients through every way a match can end.
 *
 *   node tools/escrow-test.mjs
 */
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { attachRelay } from '../server/relay.mjs';

const STAKE = 1_000_000n;
const payouts = [];
const usedTx = new Set();

const fakeEscrow = {
  enabled: true,
  treasury: '0x0000000000000000000000000000000000000T',
  limits: { min: 100_000n, max: 25_000_000n, feeBps: 0 },
  info: { escrow: true, treasury: '0xTREASURY', minStake: '100000', maxStake: '25000000', feeBps: 0 },
  // token "alice" / "bob" stands in for a Privy identity token
  async authenticate(token) {
    if (token !== 'alice' && token !== 'bob' && token !== 'carol') throw new Error('bad token');
    return { userId: token, wallet: `0x${token}`.padEnd(42, '0') };
  },
  // tx hash "ok:<amount>:<id>" pays that amount once
  async acceptStake({ txHash }) {
    const [kind, amount] = String(txHash).split(':');
    if (usedTx.has(txHash)) throw new Error('that transaction was already used');
    if (kind !== 'ok') throw new Error('transaction reverted');
    usedTx.add(txHash);
    return BigInt(amount);
  },
  enqueue(key, to, amount, reason) {
    if (!payouts.some((p) => p.key === key)) payouts.push({ key, to, amount, reason });
  },
};

const server = createServer();
attachRelay(server, { env: {}, escrow: fakeEscrow });
await new Promise((r) => server.listen(0, r));
const url = `ws://localhost:${server.address().port}/ws`;

class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => this.inbox.push(JSON.parse(d)));
    this.ready = new Promise((r) => this.ws.on('open', r));
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async expect(t, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.inbox.findIndex((m) => m.t === t);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`${this.name}: timed out waiting for "${t}" (got ${JSON.stringify(this.inbox.map((m) => m.t))})`);
  }
  async auth() {
    await this.ready;
    await this.expect('hello');
    this.send({ t: 'auth', token: this.name });
    await this.expect('authed');
  }
  close() { this.ws.close(); }
}

const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 0;
const tx = (amount = STAKE) => `ok:${amount}:${++seq}`;

/** Start a staked match between two fresh clients; returns them after the start message. */
async function startMatch() {
  const a = new Client('alice');
  const b = new Client('bob');
  await a.auth();
  await b.auth();
  a.send({ t: 'create', stake: STAKE.toString(), avatar: 2 });
  const payReq = await a.expect('pay');
  check('creator is asked to pay the stake', payReq.amount === STAKE.toString());
  a.send({ t: 'paid', txHash: tx() });
  const created = await a.expect('created');
  b.send({ t: 'join', code: created.code, avatar: 5 });
  const joinPay = await b.expect('pay');
  check('joiner is told the bet before paying', joinPay.amount === STAKE.toString() && joinPay.joining === true);
  b.send({ t: 'paid', txHash: tx() });
  const sa = await a.expect('start');
  const sb = await b.expect('start');
  check('both players start with the same seed and the right avatars', sa.seed === sb.seed && sa.oppAvatar === 5 && sb.oppAvatar === 2 && sa.slot === 0 && sb.slot === 1);
  return { a, b };
}

// --- 1. both agree alice won -> alice gets the whole pot
{
  payouts.length = 0;
  const { a, b } = await startMatch();
  a.send({ t: 'result', w: 'me' });
  b.send({ t: 'result', w: 'opp' });
  const sa = await a.expect('settled');
  const sb = await b.expect('settled');
  check('agreed result: winner is told they won the pot', sa.outcome === 'win' && sa.amount === (STAKE * 2n).toString());
  check('agreed result: loser is told they lost', sb.outcome === 'lose');
  check('agreed result: exactly one payout of 2x stake to alice', payouts.length === 1 && payouts[0].amount === STAKE * 2n && payouts[0].to.startsWith('0xalice'), show(payouts));
  a.close(); b.close();
}

// --- 2. both say they won -> refund both
{
  payouts.length = 0;
  const { a, b } = await startMatch();
  a.send({ t: 'result', w: 'me' });
  b.send({ t: 'result', w: 'me' });
  const sa = await a.expect('settled');
  const sb = await b.expect('settled');
  check('disagreement: both are refunded', sa.outcome === 'refund' && sb.outcome === 'refund');
  check('disagreement: two refunds of 1x stake, no win payout', payouts.length === 2 && payouts.every((p) => p.reason === 'refund' && p.amount === STAKE), show(payouts));
  a.close(); b.close();
}

// --- 3. one player leaves mid-match -> refund both, remaining player told
{
  payouts.length = 0;
  const { a, b } = await startMatch();
  b.close();
  await a.expect('left');
  const sa = await a.expect('settled');
  await sleep(100);
  check('leaving mid-match: stayer is refunded', sa.outcome === 'refund');
  check('leaving mid-match: both stakes queued for refund', payouts.length === 2 && payouts.every((p) => p.reason === 'refund'), show(payouts));
  a.close();
}

// --- 4. creator cancels before anyone joins -> creator refunded
{
  payouts.length = 0;
  const a = new Client('alice');
  await a.auth();
  a.send({ t: 'create', stake: STAKE.toString(), avatar: 0 });
  await a.expect('pay');
  a.send({ t: 'paid', txHash: tx() });
  await a.expect('created');
  a.send({ t: 'cancel' });
  await sleep(100);
  check('cancel before start: creator stake refunded', payouts.length === 1 && payouts[0].reason === 'refund' && payouts[0].amount === STAKE, show(payouts));
  a.close();
}

// --- 5. replaying a payment is rejected
{
  const a = new Client('alice');
  await a.auth();
  const hash = tx();
  a.send({ t: 'create', stake: STAKE.toString(), avatar: 0 });
  await a.expect('pay');
  a.send({ t: 'paid', txHash: hash });
  await a.expect('created');
  const c = new Client('carol');
  await c.auth();
  c.send({ t: 'create', stake: STAKE.toString(), avatar: 0 });
  await c.expect('pay');
  c.send({ t: 'paid', txHash: hash });
  const err = await c.expect('error');
  check('a payment cannot be used twice', /already used/.test(err.msg), err.msg);
  a.close(); c.close();
}

// --- 6. underpaying is refunded and does not open the room
{
  payouts.length = 0;
  const a = new Client('alice');
  await a.auth();
  a.send({ t: 'create', stake: STAKE.toString(), avatar: 0 });
  await a.expect('pay');
  a.send({ t: 'paid', txHash: tx(STAKE / 2n) });
  const err = await a.expect('error');
  check('underpayment is rejected and refunded', /smaller than the bet/.test(err.msg) && payouts.some((p) => p.reason === 'refund' && p.amount === STAKE / 2n), `${err.msg} ${show(payouts)}`);
  a.close();
}

// --- 7. overpaying: the extra comes back, the room still opens
{
  payouts.length = 0;
  const a = new Client('alice');
  await a.auth();
  a.send({ t: 'create', stake: STAKE.toString(), avatar: 0 });
  await a.expect('pay');
  a.send({ t: 'paid', txHash: tx(STAKE + 250_000n) });
  await a.expect('created');
  check('overpayment: extra is refunded', payouts.some((p) => p.amount === 250_000n && p.reason === 'refund'), show(payouts));
  a.close();
}

// --- 8. no sign-in, bad bet, own room
{
  const a = new Client('alice');
  await a.ready;
  await a.expect('hello');
  a.send({ t: 'create', stake: STAKE.toString(), avatar: 0 });
  check('creating a room without signing in is refused', /Sign in/.test((await a.expect('error')).msg));
  a.send({ t: 'auth', token: 'alice' });
  await a.expect('authed');
  a.send({ t: 'create', stake: '1', avatar: 0 });
  check('a bet below the minimum is refused', /outside the allowed range/.test((await a.expect('error')).msg));
  a.send({ t: 'create', stake: '999999999999', avatar: 0 });
  check('a bet above the maximum is refused', /outside the allowed range/.test((await a.expect('error')).msg));
  a.send({ t: 'create', stake: STAKE.toString(), avatar: 0 });
  await a.expect('pay');
  a.send({ t: 'paid', txHash: tx() });
  const room = await a.expect('created');
  const a2 = new Client('alice');
  await a2.auth();
  a2.send({ t: 'join', code: room.code, avatar: 0 });
  check('you cannot join your own room', /own room/.test((await a2.expect('error')).msg));
  a.close(); a2.close();
}

// --- 9. payment arrives after the room vanished -> refunded anyway
{
  await sleep(200); // let the previous test's sockets finish closing before we reset the ledger
  payouts.length = 0;
  const a = new Client('alice');
  await a.auth();
  a.send({ t: 'create', stake: STAKE.toString(), avatar: 0 });
  await a.expect('pay');
  a.send({ t: 'cancel' }); // gives up before the transfer is reported
  await sleep(50);
  a.send({ t: 'paid', txHash: tx() });
  const s = await a.expect('settled');
  check('late payment into a closed room is refunded', s.outcome === 'refund' && payouts.length === 1 && payouts[0].amount === STAKE, show(payouts));
  a.close();
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall escrow checks passed');
server.close();
process.exit(failures ? 1 : 0);
