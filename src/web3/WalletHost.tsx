import { useEffect } from 'react';
import { PrivyProvider, getIdentityToken, usePrivy, useWallets } from '@privy-io/react-auth';
import { createWalletClient, custom, erc20Abi, getAddress } from 'viem';
import { USDC_ADDRESS, chain, formatUsdc, publicClient, readUsdcBalance } from './arc';
import { setWallet } from './bridge';

/** Gas on Arc is paid from the same USDC balance; keep a little headroom. */
const GAS_HEADROOM = 50_000n;

/** Renders nothing. Keeps the Privy session and exposes it to the game through the bridge. */
function Bridge() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const embedded = wallets.find((w) => w.walletClientType === 'privy') ?? wallets[0];
  const address = embedded?.address ?? null;

  useEffect(() => {
    setWallet({
      ready,
      authenticated,
      address,
      login: () => login(),
      logout: async () => {
        await logout();
      },
      token: () => getIdentityToken().catch(() => null),
      pay: async (to, amount, onSent) => {
        if (!embedded) throw new Error('No wallet yet. Sign in again.');
        const balance = await readUsdcBalance(embedded.address);
        if (balance < amount + GAS_HEADROOM) {
          throw new Error(`Not enough USDC: you have ${formatUsdc(balance)}, need ${formatUsdc(amount)} plus about ${formatUsdc(GAS_HEADROOM)} for gas.`);
        }
        await embedded.switchChain(chain.id);
        const client = createWalletClient({
          account: getAddress(embedded.address),
          chain,
          transport: custom(await embedded.getEthereumProvider()),
        });
        const hash = await client.writeContract({
          address: USDC_ADDRESS,
          abi: erc20Abi,
          functionName: 'transfer',
          args: [getAddress(to), amount],
        });
        onSent?.(hash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new Error('Payment failed on-chain.');
        return hash;
      },
    });
  }, [ready, authenticated, address, embedded, login, logout]);

  useEffect(() => () => setWallet(null), []);
  return null;
}

export default function WalletHost({ appId }: { appId: string }) {
  return (
    <PrivyProvider
      appId={appId}
      config={{
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        loginMethods: ['email', 'google'],
        defaultChain: chain,
        supportedChains: [chain],
        appearance: { theme: 'dark', accentColor: '#d8452f' },
      }}
    >
      <Bridge />
    </PrivyProvider>
  );
}
