import { createRoot } from 'react-dom/client';
import WalletHost from './WalletHost';

/** Starts the wallet layer (invisible until Privy opens its sign-in modal). */
export function mountWallet(): void {
  const appId = import.meta.env.VITE_PRIVY_APP_ID as string | undefined;
  if (!appId) return;
  let el = document.getElementById('web3');
  if (!el) {
    el = document.createElement('div');
    el.id = 'web3';
    document.body.appendChild(el);
  }
  createRoot(el).render(<WalletHost appId={appId} />);
}
