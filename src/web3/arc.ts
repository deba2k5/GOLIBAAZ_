/** Arc network table + USDC helpers (same values the akipoly site and backend use). */
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, parseUnits, type Chain } from 'viem';
import { arc as arcMainnet, arcTestnet } from 'viem/chains';

export const USDC_DECIMALS = 6;
export const USDC_ADDRESS = getAddress('0x3600000000000000000000000000000000000000');

const NETWORKS = {
  testnet: { name: 'Arc Testnet', rpcUrl: 'https://rpc.testnet.arc.io', explorerUrl: 'https://explorer.testnet.arc.io', faucetUrl: 'https://faucet.circle.com/' },
  mainnet: { name: 'Arc', rpcUrl: 'https://rpc.mainnet.arc.io', explorerUrl: 'https://explorer.arc.io', faucetUrl: null as string | null },
};

const requested = (import.meta.env.VITE_ARC_NETWORK as string | undefined) === 'mainnet' ? 'mainnet' : 'testnet';
export const network = { ...NETWORKS[requested], network: requested };
export const chain: Chain = requested === 'mainnet' ? arcMainnet : arcTestnet;
export const publicClient = createPublicClient({ chain, transport: http(network.rpcUrl), pollingInterval: 500 });

/** Base units (6dp) -> "1.5". */
export function formatUsdc(v: string | bigint): string {
  const s = formatUnits(BigInt(v), USDC_DECIMALS);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function parseUsdc(v: string): bigint | null {
  const t = v.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  return parseUnits(t, USDC_DECIMALS);
}

export function readUsdcBalance(address: string): Promise<bigint> {
  return publicClient.readContract({ address: USDC_ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [getAddress(address)] });
}

export const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
