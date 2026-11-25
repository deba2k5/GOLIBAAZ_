/**
 * The wallet lives in React (Privy); the game lives in Phaser. This is the thin handoff between
 * them: WalletHost registers an api here and the scenes call it.
 */
export interface WalletApi {
  ready: boolean;
  authenticated: boolean;
  address: string | null;
  login: () => void;
  logout: () => Promise<void>;
  /** Privy identity token the relay verifies. */
  token: () => Promise<string | null>;
  /** Send USDC to `to` and wait for the receipt. Returns the tx hash. */
  pay: (to: string, amount: bigint, onSent?: (hash: string) => void) => Promise<string>;
}

/** Wallet features are on only when a Privy app id is configured. */
export const web3Enabled = Boolean(import.meta.env.VITE_PRIVY_APP_ID);

let current: WalletApi | null = null;
const listeners = new Set<(a: WalletApi | null) => void>();

export const wallet = (): WalletApi | null => current;

export function setWallet(api: WalletApi | null): void {
  current = api;
  for (const l of listeners) l(api);
}

export function onWallet(fn: (a: WalletApi | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
