import Phaser from 'phaser';
import { GH, GW, THEMES } from '../config';
import { audio } from '../core/audio';
import { isTouch } from '../core/device';
import { CREAM, DIM, GOLD, RED, label, makeButton } from '../scenes/widgets';
import { formatUsdc, network, readUsdcBalance, shortAddress } from '../web3/arc';
import { type WalletApi, onWallet, wallet } from '../web3/bridge';
import { ensureAuth, ensureNet, resetSession, session } from './session';

/** Bets you can step through, in USDC. Trimmed to what the server allows. */
const PRESETS = ['0.1', '0.25', '0.5', '1', '2', '5', '10', '25'];
const toUnits = (v: string) => BigInt(Math.round(Number(v) * 1e6));

/** Step 1 of versus: sign in with your wallet and choose what you are betting. */
export class BetScene extends Phaser.Scene {
  private idx = 3;
  private presets: bigint[] = [];
  private status!: Phaser.GameObjects.Text;
  private wallet!: Phaser.GameObjects.Text;
  private stakeText!: Phaser.GameObjects.Text;
  private potText!: Phaser.GameObjects.Text;
  private signIn!: ReturnType<typeof makeButton>;
  private copyBtn!: ReturnType<typeof makeButton>;
  private faucetBtn!: ReturnType<typeof makeButton> | null;
  private copyTimer: Phaser.Time.TimerEvent | null = null;
  private next!: ReturnType<typeof makeButton>;
  private balance: bigint | null = null;
  private lastBalanceAt = 0;
  private lastAddress: string | null = null;
  private ready = false;
  private busy = false;
  private off: (() => void)[] = [];

  constructor() {
    super('Bet');
  }

  create(): void {
    this.ready = false;
    this.busy = false;
    this.balance = null;
    this.lastBalanceAt = 0;
    this.lastAddress = null;
    this.off = [];
    const touch = isTouch();
    this.cameras.main.setBackgroundColor(THEMES[0].bg);
    this.input.setDefaultCursor(touch ? 'default' : 'auto');
    this.add.image(GW / 2, GH / 2, 'vignette').setDisplaySize(GW, GH).setDepth(1);
    this.add.image(GW / 2, 300, 'light').setScale(7, 3.2).setTint(0xff9a50).setAlpha(0.18).setBlendMode(Phaser.BlendModes.ADD);

    label(this, GW / 2, touch ? 120 : 140, 'PLACE YOUR BET', touch ? 130 : 130, CREAM, '700', 18).setDepth(10).setShadow(0, 10, '#000000', 24, false, true);
    this.add.rectangle(GW / 2, touch ? 210 : 226, 560, 5, 0xd8452f).setDepth(10);
    label(this, GW / 2, touch ? 262 : 270, 'STEP 1 OF 3  ·  BET   >   AVATAR   >   ROOM', touch ? 30 : 22, DIM, '500', 8).setDepth(10);

    const y = touch ? 360 : 360;
    this.wallet = label(this, GW / 2, y, 'Connecting…', touch ? 40 : 28, CREAM, '500', 3).setDepth(10);
    this.status = label(this, GW / 2, touch ? 990 : 930, '', touch ? 34 : 24, DIM, '500', 2).setDepth(10);

    // bet stepper
    const sy = touch ? 600 : 560;
    const so = touch ? { w: 150, h: 150, size: 80 } : { w: 96, h: 96, size: 56 };
    this.stakeText = label(this, GW / 2, sy, '', touch ? 170 : 140, GOLD, '700', 8).setDepth(10).setShadow(0, 8, '#000000', 18, false, true);
    makeButton(this, GW / 2 - (touch ? 520 : 420), sy, '–', () => this.step(-1), so).c.setDepth(10);
    makeButton(this, GW / 2 + (touch ? 520 : 420), sy, '+', () => this.step(1), so).c.setDepth(10);
    this.potText = label(this, GW / 2, sy + (touch ? 130 : 110), '', touch ? 36 : 26, DIM, '500', 3).setDepth(10);

    const ob = touch ? { w: 640, h: 140, size: 48 } : { w: 380, h: 76, size: 32 };
    const by = touch ? 840 : 780;
    this.signIn = makeButton(this, GW / 2, by, 'SIGN IN', () => this.onSignIn(), { ...ob, primary: true });
    this.next = makeButton(this, GW / 2, by, 'NEXT  ·  AVATAR', () => void this.onNext(), { ...ob, primary: true });
    this.signIn.c.setDepth(10);
    this.next.c.setDepth(10).setVisible(false);
    makeButton(this, touch ? GW / 2 : 300, touch ? by + 150 : by, 'BACK', () => this.back(), touch ? { w: 480, h: 110, size: 40 } : { w: 240 }).c.setDepth(10);

    // wallet tools, shown once you are signed in: copy your address, grab free test USDC
    const ty = touch ? 450 : 432;
    const tb = touch ? { w: 520, h: 100, size: 36 } : { w: 280, h: 58, size: 22 };
    const hasFaucet = !!network.faucetUrl;
    const tx = touch ? (hasFaucet ? GW / 2 - 290 : GW / 2) : (hasFaucet ? GW / 2 - 160 : GW / 2);
    this.copyBtn = makeButton(this, tx, ty, 'COPY ADDRESS', () => void this.copyAddress(), tb);
    this.copyBtn.c.setDepth(10).setVisible(false);
    this.faucetBtn = null;
    if (hasFaucet) {
      this.faucetBtn = makeButton(this, touch ? GW / 2 + 290 : GW / 2 + 160, ty, 'GET TEST USDC', () => this.openFaucet(), tb);
      this.faucetBtn.c.setDepth(10).setVisible(false);
    }

    this.off.push(onWallet(() => this.refreshWallet()));
    this.input.keyboard!.on('keydown-ESC', () => this.back());
    this.events.once('shutdown', () => {
      for (const f of this.off) f();
      this.input.keyboard?.off('keydown-ESC');
    });
    audio.setIntensity(0);
    void this.connect();
  }

  private async connect(): Promise<void> {
    try {
      await ensureNet();
    } catch (err) {
      this.say((err as Error).message || 'Could not reach the game server.', RED);
      this.wallet.setText('Server offline');
      return;
    }
    const info = session.info!;
    if (!info.escrow) {
      // the relay has no treasury configured: play for fun, no bets
      session.stake = 0n;
      this.scene.start('Avatar');
      return;
    }
    const min = BigInt(info.minStake ?? '0');
    const max = BigInt(info.maxStake ?? '0');
    this.presets = PRESETS.map(toUnits).filter((p) => p >= min && p <= max);
    if (!this.presets.length) this.presets = [min];
    this.idx = Math.min(this.presets.length - 1, Math.max(0, this.presets.findIndex((p) => p >= toUnits('1'))));
    if (session.stake > 0n) {
      const found = this.presets.indexOf(session.stake);
      if (found >= 0) this.idx = found;
    }
    this.ready = true;
    this.renderStake();
    this.refreshWallet();
  }

  private say(text: string, colour = DIM): void {
    this.status.setText(text).setColor(colour);
  }

  private step(d: number): void {
    if (!this.ready) return;
    this.idx = Math.min(this.presets.length - 1, Math.max(0, this.idx + d));
    this.renderStake();
  }

  private renderStake(): void {
    const s = this.presets[this.idx] ?? 0n;
    this.stakeText.setText(`${formatUsdc(s)} USDC`);
    this.potText.setText(`WINNER TAKES ${formatUsdc(s * 2n)} USDC  ·  ${network.name.toUpperCase()}`);
  }

  private refreshWallet(): void {
    if (!this.ready) return;
    const api = wallet();
    const signedIn = !!api?.authenticated && !!api.address;
    this.signIn.c.setVisible(!signedIn);
    this.next.c.setVisible(signedIn);
    this.copyBtn.c.setVisible(signedIn);
    this.faucetBtn?.c.setVisible(signedIn);
    if (!api?.ready) {
      this.wallet.setText('Starting wallet…').setColor(DIM);
      return;
    }
    if (!signedIn) {
      this.wallet.setText('Sign in to bet. Your wallet is created for you.').setColor(CREAM);
      this.balance = null;
      this.lastAddress = null;
      return;
    }
    const addr = api.address!;
    if (addr !== this.lastAddress) {
      this.lastAddress = addr;
      this.lastBalanceAt = 0;
    }
    this.wallet.setText(`WALLET ${shortAddress(addr)}   ·   ${this.balance === null ? '…' : `${formatUsdc(this.balance)} USDC`}`).setColor(CREAM);
    if (network.faucetUrl && this.balance !== null && this.balance < (this.presets[this.idx] ?? 0n)) {
      this.say(`Low balance. Free test USDC: ${network.faucetUrl}  (choose Arc Testnet)`, GOLD);
    }
  }

  update(time: number): void {
    const api = wallet();
    if (this.ready && api?.authenticated && api.address && time - this.lastBalanceAt > 8000) {
      this.lastBalanceAt = time;
      readUsdcBalance(api.address)
        .then((b) => {
          this.balance = b;
          this.refreshWallet();
        })
        .catch(() => {});
    }
  }

  /** Copy the full wallet address so it can be pasted into the faucet or sent to a friend. */
  private async copyAddress(): Promise<void> {
    const addr = wallet()?.address;
    if (!addr) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(addr);
      ok = true;
    } catch {
      // clipboard blocked (some embedded browsers): fall back to a temporary text field
      const el = document.createElement('textarea');
      el.value = addr;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      el.remove();
    }
    if (!ok) return this.say(`Could not copy. Your address is ${addr}`, GOLD);
    this.copyBtn.setLabel('COPIED');
    this.say('Wallet address copied. Paste it into the faucet to get free test USDC.', GOLD);
    this.copyTimer?.remove();
    this.copyTimer = this.time.delayedCall(1800, () => this.copyBtn.setLabel('COPY ADDRESS'));
  }

  /** Circle's faucet: choose Arc Testnet, paste the address, get free test USDC. */
  private openFaucet(): void {
    if (!network.faucetUrl) return;
    window.open(network.faucetUrl, '_blank', 'noopener');
    this.say('Faucet opened in a new tab: pick Arc Testnet and paste your address.', GOLD);
  }

  private onSignIn(): void {
    const api = wallet();
    if (!api) return this.say('The wallet is still starting. One moment.', DIM);
    if (!api.ready) return this.say('The wallet is still starting. One moment.', DIM);
    api.login();
  }

  private async onNext(): Promise<void> {
    if (this.busy || !this.ready) return;
    const api = wallet();
    if (!api?.authenticated) return this.say('Sign in first.', RED);
    const stake = this.presets[this.idx];
    if (this.balance !== null && this.balance < stake) {
      this.say(`You need at least ${formatUsdc(stake)} USDC plus a little for gas.`, RED);
      return;
    }
    this.busy = true;
    this.say('Checking your sign-in…', DIM);
    try {
      await ensureAuth(await ensureNet());
    } catch (err) {
      this.busy = false;
      this.say((err as Error).message, RED);
      return;
    }
    session.stake = stake;
    this.busy = false;
    audio.play('click');
    this.scene.start('Avatar');
  }

  private back(): void {
    resetSession();
    this.scene.start('Menu');
  }
}
