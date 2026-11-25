/**
 * GOLIBAAZ escrow: takes both players' stakes in USDC on Arc, then pays the winner.
 *
 *  - Players sign in with Privy; the identity token tells us their embedded wallet, the only
 *    address we accept a stake from and pay out to.
 *  - A stake is a plain USDC transfer to the treasury; we verify it on-chain, and each tx hash can
 *    be used once.
 *  - Payouts go through a tiny durable queue (data/ledger.json): the signed transaction is saved
 *    before it is broadcast, so a crash can only ever rebroadcast the same transfer.
 *
 * Disabled (free play) unless GOLIBAAZ_TREASURY_PRIVATE_KEY and PRIVY_APP_ID are set.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  parseEventLogs,
  parseUnits,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arc as arcMainnet, arcTestnet } from 'viem/chains';

const NETWORKS = {
  testnet: { name: 'Arc Testnet', chainId: 5042002, rpc: 'https://rpc.testnet.arc.io', chain: arcTestnet, explorer: 'https://explorer.testnet.arc.io', faucet: 'https://faucet.circle.com/' },
  mainnet: { name: 'Arc', chainId: 5042, rpc: 'https://rpc.mainnet.arc.io', chain: arcMainnet, explorer: 'https://explorer.arc.io', faucet: null },
};
const USDC = '0x3600000000000000000000000000000000000000';
const DECIMALS = 6;

const usdc = (v, fallback) => parseUnits(String(v ?? fallback), DECIMALS);

function parseLinkedAccounts(claim) {
  if (Array.isArray(claim)) return claim;
  if (typeof claim === 'string') {
    try {
      const p = JSON.parse(claim);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}

function embeddedWallet(claim) {
  const wallets = parseLinkedAccounts(claim).filter(
    (a) => a.type === 'wallet' && (a.chain_type ?? a.chainType) === 'ethereum' && a.address,
  );
  const w = wallets.find((x) => (x.wallet_client_type ?? x.walletClientType) === 'privy') ?? wallets[0];
  return w?.address ? getAddress(w.address) : null;
}

export function createEscrow(env, log = console) {
  const key = env.GOLIBAAZ_TREASURY_PRIVATE_KEY;
  const appId = env.PRIVY_APP_ID ?? env.VITE_PRIVY_APP_ID;
  if (!key || !appId || !/^0x[0-9a-fA-F]{64}$/.test(key)) return { enabled: false };

  const net = NETWORKS[env.ARC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'];
  const transport = http(env.ARC_RPC_URL || net.rpc, { retryCount: 3, timeout: 15_000 });
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: net.chain, transport, pollingInterval: 500 });
  const walletClient = createWalletClient({ chain: net.chain, transport, account });
  const treasury = account.address;
  const usdcAddr = getAddress(USDC);
  const jwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`));

  const limits = {
    min: usdc(env.MIN_STAKE_USDC, '0.1'),
    max: usdc(env.MAX_STAKE_USDC, '25'),
    maxAutoPayout: usdc(env.MAX_AUTO_PAYOUT_USDC, '100'),
    feeBps: Math.min(2000, Math.max(0, Number(env.HOUSE_FEE_BPS ?? 0) | 0)),
  };

  // ---------------------------------------------------------------- ledger
  const ledgerPath = resolve(env.GOLIBAAZ_LEDGER_PATH || 'data/ledger.json');
  /** @type {{ transfers: Record<string, object>, payouts: any[] }} */
  let ledger = { transfers: {}, payouts: [] };
  if (existsSync(ledgerPath)) {
    try {
      ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'), (k, v) => (typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
    } catch (err) {
      log.error?.('ledger unreadable, refusing to start escrow', err);
      throw err;
    }
  }
  const save = () => {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    const tmp = `${ledgerPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger, (k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2));
    renameSync(tmp, ledgerPath);
  };

  // ---------------------------------------------------------------- auth
  async function authenticate(token) {
    const { payload } = await jwtVerify(String(token), jwks, { issuer: 'privy.io', audience: appId, algorithms: ['ES256'] });
    if (!payload.sub) throw new Error('no subject');
    const wallet = embeddedWallet(payload.linked_accounts);
    if (!wallet) throw new Error('no wallet on this account');
    return { userId: payload.sub, wallet };
  }

  // ---------------------------------------------------------------- stakes in
  /**
   * Total USDC that `txHash` moved from `from` to the treasury. Throws if missing, reverted or
   * already used. Records the hash so it can never be used again.
   */
  async function acceptStake({ txHash, from, matchId }) {
    const hash = String(txHash);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('bad transaction hash');
    if (ledger.transfers[hash]) throw new Error('that transaction was already used');
    // reserve the hash first so two requests can't both spend it
    ledger.transfers[hash] = { from, matchId, amount: 0n, at: Date.now(), pending: true };
    try {
      let receipt;
      try {
        receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
      } catch {
        throw new Error('payment not confirmed on-chain yet, try again in a moment');
      }
      if (receipt.status !== 'success') throw new Error('transaction reverted');
      const f = getAddress(from);
      const total = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
        .filter((l) => getAddress(l.address) === usdcAddr && getAddress(l.args.from) === f && getAddress(l.args.to) === treasury)
        .reduce((s, l) => s + l.args.value, 0n);
      if (total === 0n) throw new Error('no USDC transfer from your wallet to the treasury in that transaction');
      ledger.transfers[hash] = { from, matchId, amount: total, at: Date.now() };
      save();
      return total;
    } catch (err) {
      delete ledger.transfers[hash];
      throw err;
    }
  }

  // ---------------------------------------------------------------- payouts out
  /** Idempotent: one payout per key, ever. */
  function enqueue(payKey, to, amount, reason) {
    if (amount <= 0n || ledger.payouts.some((p) => p.key === payKey)) return;
    const held = amount > limits.maxAutoPayout;
    ledger.payouts.push({ key: payKey, to: getAddress(to), amount, reason, status: held ? 'held' : 'pending', attempts: 0, at: Date.now() });
    save();
    log.info?.(`payout queued ${payKey} ${amount} -> ${to} (${reason})`);
  }

  async function payoutTick() {
    const p = ledger.payouts.find((x) => x.status === 'pending' || x.status === 'sent');
    if (!p) return;
    if (p.status === 'pending') {
      try {
        const request = await walletClient.prepareTransactionRequest({
          to: usdcAddr,
          data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [p.to, p.amount] }),
        });
        const raw = await walletClient.signTransaction(request);
        p.raw = raw;
        p.txHash = keccak256(raw);
        p.status = 'sent';
        p.sentAt = Date.now();
        save(); // signed tx is on disk before it hits the network
        await publicClient.sendRawTransaction({ serializedTransaction: raw }).catch(() => {});
      } catch (err) {
        p.attempts++;
        p.error = String(err).slice(0, 300);
        if (p.attempts >= 5) p.status = 'failed';
        save();
        log.error?.(`payout ${p.key} signing failed (${p.attempts})`, p.error);
      }
      return;
    }
    // sent: wait for it to land
    try {
      const r = await publicClient.getTransactionReceipt({ hash: p.txHash });
      p.status = r.status === 'success' ? 'confirmed' : 'failed';
      save();
      log.info?.(`payout ${p.key} ${p.status} ${p.txHash}`);
    } catch {
      if (Date.now() - p.sentAt > 20_000) {
        p.sentAt = Date.now();
        save();
        await publicClient.sendRawTransaction({ serializedTransaction: p.raw }).catch(() => {});
      }
      if (Date.now() - p.at > 10 * 60_000) {
        p.status = 'held';
        p.error = 'never confirmed, needs a human';
        save();
      }
    }
  }
  const timer = setInterval(() => void payoutTick().catch((e) => log.error?.('payout tick', e)), 2000);
  timer.unref?.();

  return {
    enabled: true,
    treasury,
    limits,
    info: {
      escrow: true,
      treasury,
      network: net.name,
      chainId: net.chainId,
      explorer: net.explorer,
      faucet: net.faucet,
      minStake: limits.min.toString(),
      maxStake: limits.max.toString(),
      feeBps: limits.feeBps,
    },
    authenticate,
    acceptStake,
    enqueue,
  };
}
