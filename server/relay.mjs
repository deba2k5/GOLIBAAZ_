/**
 * GOLIBAAZ versus relay (+ optional USDC escrow, see escrow.mjs).
 *
 * Pairs two players into a room and forwards their game messages to each other. In escrow mode it
 * also takes both stakes before the match and pays the winner after, but it still knows nothing
 * about the game itself: each client reports its own result and the two must agree.
 *
 *   server -> client  { t: 'hello', escrow, ... }          sent on connect (escrow info or { escrow: false })
 *   client -> server  { t: 'auth', token }                  Privy identity token (escrow mode)
 *                     { t: 'create', stake?, avatar }       open a room; escrow mode: pay first
 *                     { t: 'join', code, avatar }           join a room; escrow mode: pay first
 *                     { t: 'paid', txHash }                 proof of the stake transfer
 *                     { t: 'cancel' }                       leave a room that has not started
 *                     { t: 'result', w: 'me'|'opp'|'draw' } who won, from this player's point of view
 *   server -> client  { t: 'pay', amount, treasury }        send this much USDC, then reply 'paid'
 *                     { t: 'created', code, stake }
 *                     { t: 'start', slot, seed, stake, avatar, oppAvatar }
 *                     { t: 'settled', outcome: 'win'|'lose'|'refund', amount }
 *                     { t: 'left' } / { t: 'error', msg }
 *   anything else is forwarded unchanged to the other player once the match has started.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createEscrow } from './escrow.mjs';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 500;
const MAX_MSG_PER_SEC = 120;
const RESULT_GRACE_MS = 25_000;
const AVATARS = 8;

const cleanAvatar = (a) => (Number.isInteger(a) && a >= 0 && a < AVATARS ? a : 0);

/** Minimal .env reader for standalone runs (Vite passes its own env in). */
export function readDotEnv(path = '.env') {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function attachRelay(httpServer, opts = {}) {
  const path = opts.path ?? '/ws';
  const env = { ...readDotEnv(), ...process.env, ...(opts.env ?? {}) };
  const log = { info: (...a) => console.log('[relay]', ...a), error: (...a) => console.error('[relay]', ...a) };
  let escrow;
  try {
    // opts.escrow lets tests swap in a fake payment layer
    escrow = opts.escrow ?? createEscrow(env, log);
  } catch (err) {
    log.error('escrow failed to start, running free play only:', err?.message ?? err);
    escrow = { enabled: false };
  }
  log.info(escrow.enabled ? `escrow ON, treasury ${escrow.treasury}` : 'escrow off (free play)');

  /** code -> room */
  const rooms = new Map();
  let matchSeq = 0;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });

  // Browsers allowed to open a socket (comma-separated origins). Empty = any, which is fine locally.
  const allowedOrigins = String(env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

  httpServer.on('upgrade', (req, socket, head) => {
    // Vite's own HMR socket also arrives here; only take our path.
    if (!req.url || !req.url.startsWith(path)) return;
    if (allowedOrigins.length && !allowedOrigins.includes(req.headers.origin ?? '')) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const send = (ws, msg) => {
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const fail = (ws, msg) => send(ws, { t: 'error', msg });

  const newCode = () => {
    for (let n = 0; n < 50; n++) {
      let c = '';
      for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  };

  const staked = (room) => escrow.enabled && room.stake > 0n;

  // ---------------------------------------------------------------- settlement
  function settle(room, claims, why) {
    if (room.settled) return;
    room.settled = true;
    clearTimeout(room.graceTimer);
    if (!staked(room)) return;
    const [a, b] = room.players;
    const pot = room.stake * 2n;
    const fee = (pot * BigInt(escrow.limits.feeBps)) / 10_000n;
    let winner = -2; // -2 = refund, -1 = draw (refund), 0/1 = that slot wins
    if (claims && claims[0] !== undefined && claims[0] === claims[1]) winner = claims[0];
    if (winner === 0 || winner === 1) {
      const w = room.players[winner];
      const l = room.players[1 - winner];
      escrow.enqueue(`match:${room.id}:win`, w.wallet, pot - fee, 'win');
      send(w.ws, { t: 'settled', outcome: 'win', amount: (pot - fee).toString() });
      send(l.ws, { t: 'settled', outcome: 'lose', amount: '0' });
      log.info(`match ${room.id} won by slot ${winner} (${why})`);
    } else {
      for (const [i, p] of [a, b].entries()) {
        if (!p.paid) continue;
        escrow.enqueue(`match:${room.id}:refund:${i}`, p.wallet, room.stake, 'refund');
        send(p.ws, { t: 'settled', outcome: 'refund', amount: room.stake.toString() });
      }
      log.info(`match ${room.id} refunded (${why})`);
    }
  }

  function maybeSettle(room) {
    if (room.settled || !room.started) return;
    const claims = room.players.map((p) => p.claim);
    if (claims.every((c) => c !== undefined)) settle(room, claims, 'both reported');
  }

  // ---------------------------------------------------------------- leaving
  const leave = (ws) => {
    const code = ws.room;
    if (!code) return;
    ws.room = null;
    const room = rooms.get(code);
    if (!room) return;
    const me = room.players.find((p) => p.ws === ws);
    if (!me) return;

    if (!room.started) {
      // never started: give the creator's stake back, drop the room or free the seat
      if (me.paid) escrow.enabled && escrow.enqueue(`match:${room.id}:abort:${me.slot}`, me.wallet, room.stake, 'refund');
      room.players = room.players.filter((p) => p !== me);
      if (me.slot === 0 || room.players.length === 0) {
        for (const p of room.players) {
          send(p.ws, { t: 'left' });
          p.ws.room = null;
        }
        rooms.delete(code);
      }
      return;
    }

    // mid-match: nobody can say who won, so everyone is refunded
    for (const p of room.players) if (p !== me) send(p.ws, { t: 'left' });
    settle(room, null, 'a player left');
    rooms.delete(code);
  };

  // ---------------------------------------------------------------- handlers
  async function onAuth(ws, msg) {
    if (!escrow.enabled) return send(ws, { t: 'authed' });
    try {
      ws.user = await escrow.authenticate(msg.token);
      send(ws, { t: 'authed', wallet: ws.user.wallet });
    } catch (err) {
      ws.user = null;
      fail(ws, 'Sign-in expired. Please sign in again.');
      log.error('auth', err?.message ?? err);
    }
  }

  function onCreate(ws, msg) {
    leave(ws);
    if (rooms.size >= MAX_ROOMS) return fail(ws, 'Server is full, try again soon.');
    let stake = 0n;
    if (escrow.enabled) {
      if (!ws.user) return fail(ws, 'Sign in first.');
      try {
        stake = BigInt(msg.stake);
      } catch {
        return fail(ws, 'Pick a bet first.');
      }
      if (stake < escrow.limits.min || stake > escrow.limits.max) return fail(ws, 'That bet is outside the allowed range.');
    }
    const code = newCode();
    if (!code) return fail(ws, 'Could not create a room.');
    const room = {
      id: `${Date.now().toString(36)}-${++matchSeq}`,
      code,
      stake,
      players: [{ ws, slot: 0, avatar: cleanAvatar(msg.avatar), wallet: ws.user?.wallet, userId: ws.user?.userId, paid: false }],
      seed: Math.floor(Math.random() * 0x7fffffff),
      started: false,
      open: !escrow.enabled || stake === 0n,
      settled: false,
    };
    rooms.set(code, room);
    ws.room = code;
    if (escrow.enabled && stake > 0n) return send(ws, { t: 'pay', amount: stake.toString(), treasury: escrow.treasury, code });
    send(ws, { t: 'created', code, stake: stake.toString() });
  }

  function onJoin(ws, msg) {
    leave(ws);
    if (escrow.enabled && !ws.user) return fail(ws, 'Sign in first.');
    const code = String(msg.code ?? '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room || room.started || !room.open) return fail(ws, 'No open room with that code.');
    if (room.players.length >= 2) return fail(ws, 'That room is full.');
    if (escrow.enabled && ws.user.userId === room.players[0].userId) return fail(ws, 'You cannot join your own room.');
    room.players.push({ ws, slot: 1, avatar: cleanAvatar(msg.avatar), wallet: ws.user?.wallet, userId: ws.user?.userId, paid: false });
    ws.room = code;
    if (staked(room)) {
      return send(ws, { t: 'pay', amount: room.stake.toString(), treasury: escrow.treasury, code, joining: true });
    }
    startMatch(room);
  }

  async function onPaid(ws, msg) {
    if (!escrow.enabled) return;
    const room = ws.room ? rooms.get(ws.room) : null;
    if (!room || room.started) {
      // the room vanished while this player was paying: take the money and send it straight back
      if (ws.user && msg.txHash) {
        try {
          const total = await escrow.acceptStake({ txHash: msg.txHash, from: ws.user.wallet, matchId: 'orphan' });
          escrow.enqueue(`orphan:${String(msg.txHash).toLowerCase()}`, ws.user.wallet, total, 'refund');
          send(ws, { t: 'settled', outcome: 'refund', amount: total.toString() });
        } catch (err) {
          fail(ws, err?.message ?? 'Could not process that payment.');
        }
      }
      return;
    }
    const me = room.players.find((p) => p.ws === ws);
    if (!me || me.paid || me.verifying) return;
    me.verifying = true;
    try {
      const total = await escrow.acceptStake({ txHash: msg.txHash, from: me.wallet, matchId: room.id });
      if (total < room.stake) {
        // short payment: give it back, they can try again
        escrow.enqueue(`match:${room.id}:short:${me.slot}`, me.wallet, total, 'refund');
        throw new Error('that payment was smaller than the bet and is being refunded');
      }
      if (total > room.stake) escrow.enqueue(`match:${room.id}:extra:${me.slot}`, me.wallet, total - room.stake, 'refund');
      // the room may have been torn down while we were waiting
      if (!rooms.has(room.code) || !room.players.includes(me)) {
        escrow.enqueue(`match:${room.id}:late:${me.slot}`, me.wallet, room.stake, 'refund');
        return;
      }
      me.paid = true;
      if (me.slot === 0) {
        room.open = true;
        send(ws, { t: 'created', code: room.code, stake: room.stake.toString() });
      } else if (room.players.length === 2 && room.players.every((p) => p.paid)) {
        startMatch(room);
      }
    } catch (err) {
      fail(ws, err?.message ?? 'Payment failed.');
    } finally {
      me.verifying = false;
    }
  }

  function startMatch(room) {
    room.started = true;
    room.open = false;
    room.players.forEach((p, i) => {
      const other = room.players[1 - i];
      send(p.ws, {
        t: 'start', slot: i, seed: room.seed, stake: room.stake.toString(), id: room.id,
        avatar: p.avatar, oppAvatar: other.avatar,
      });
    });
  }

  function onResult(ws, msg) {
    const room = ws.room ? rooms.get(ws.room) : null;
    if (!room || !room.started || room.settled) return;
    const me = room.players.find((p) => p.ws === ws);
    if (!me || me.claim !== undefined) return;
    me.claim = msg.w === 'me' ? me.slot : msg.w === 'opp' ? 1 - me.slot : -1;
    maybeSettle(room);
    if (!room.settled && !room.graceTimer) {
      // the other side never reports: stop waiting and refund
      room.graceTimer = setTimeout(() => settle(room, null, 'no second report'), RESULT_GRACE_MS);
    }
  }

  // ---------------------------------------------------------------- sockets
  wss.on('connection', (ws) => {
    ws.room = null;
    ws.user = null;
    ws.budget = MAX_MSG_PER_SEC;
    const refill = setInterval(() => { ws.budget = MAX_MSG_PER_SEC; }, 1000);
    send(ws, { t: 'hello', ...(escrow.enabled ? escrow.info : { escrow: false }) });

    ws.on('message', (data) => {
      if (--ws.budget < 0) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.t !== 'string') return;

      switch (msg.t) {
        case 'auth': return void onAuth(ws, msg);
        case 'create': return onCreate(ws, msg);
        case 'join': return onJoin(ws, msg);
        case 'paid': return void onPaid(ws, msg);
        case 'cancel': return leave(ws);
        case 'result': return onResult(ws, msg);
        default: {
          // game traffic for the other player
          const room = ws.room ? rooms.get(ws.room) : null;
          if (!room || !room.started) return;
          for (const p of room.players) if (p.ws !== ws) send(p.ws, msg);
        }
      }
    });

    ws.on('close', () => {
      clearInterval(refill);
      leave(ws);
    });
    ws.on('error', () => ws.close());
  });

  return wss;
}

// Standalone: `node server/relay.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT ?? 8787);
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('golibaaz relay ok\n');
  });
  attachRelay(server);
  server.listen(port, () => console.log(`golibaaz relay listening on :${port} (ws path /ws)`));
}
