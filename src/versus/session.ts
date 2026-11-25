/**
 * What the versus screens share while you click through bet -> avatar -> room:
 * one relay connection, what the relay told us about itself, your bet and your avatar.
 */
import { Net, type NetMsg } from '../core/net';
import { wallet } from '../web3/bridge';

export interface RelayInfo {
  escrow: boolean;
  treasury?: string;
  network?: string;
  explorer?: string;
  faucet?: string | null;
  minStake?: string;
  maxStake?: string;
  feeBps?: number;
}

export const session = {
  net: null as Net | null,
  info: null as RelayInfo | null,
  authed: false,
  /** Bet in USDC base units (6dp). 0 = free play. */
  stake: 0n,
  avatar: 0,
};

export function resetSession(): void {
  session.net?.close();
  session.net = null;
  session.info = null;
  session.authed = false;
}

/** Connect to the relay (if not already) and wait for its hello. */
export async function ensureNet(): Promise<Net> {
  if (session.net?.open && session.info) return session.net;
  session.net?.close();
  const net = new Net();
  session.net = net;
  session.info = null;
  session.authed = false;
  const hello = new Promise<RelayInfo>((resolve, reject) => {
    const off = net.on((m: NetMsg) => {
      if (m.t === 'hello') {
        off();
        resolve(m as unknown as RelayInfo);
      }
    });
    window.setTimeout(() => reject(new Error('The game server did not answer.')), 8000);
  });
  await net.connect();
  session.info = await hello;
  net.onClose(() => {
    if (session.net === net) {
      session.net = null;
      session.info = null;
      session.authed = false;
    }
  });
  return net;
}

/** Prove who you are to the relay with your Privy identity token (escrow mode only). */
export async function ensureAuth(net: Net): Promise<void> {
  if (!session.info?.escrow || session.authed) return;
  const api = wallet();
  if (!api?.authenticated) throw new Error('Sign in first.');
  const token = await api.token();
  if (!token) throw new Error('Could not get a sign-in token. Enable identity tokens in Privy and sign in again.');
  const reply = new Promise<void>((resolve, reject) => {
    const off = net.on((m) => {
      if (m.t === 'authed') {
        off();
        resolve();
      } else if (m.t === 'error') {
        off();
        reject(new Error(String(m.msg)));
      }
    });
    window.setTimeout(() => {
      off();
      reject(new Error('Sign-in check timed out.'));
    }, 8000);
  });
  net.send({ t: 'auth', token });
  await reply;
  session.authed = true;
}
