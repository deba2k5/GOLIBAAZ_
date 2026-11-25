import Phaser from 'phaser';
import { GH, GW, THEMES } from '../config';
import { audio } from '../core/audio';
import { isTouch } from '../core/device';
import type { Net, NetMsg } from '../core/net';
import { CREAM, DIM, GOLD, RED, label, makeButton } from '../scenes/widgets';
import { formatUsdc } from '../web3/arc';
import { wallet } from '../web3/bridge';
import { AVATARS } from './avatars';
import { ensureAuth, ensureNet, session } from './session';

/** Step 3 of versus: create a room (and share its code) or join a friend's. Pays the bet on the way in. */
export class LobbyScene extends Phaser.Scene {
  private net: Net | null = null;
  private status!: Phaser.GameObjects.Text;
  private codeText!: Phaser.GameObjects.Text;
  private panel: Phaser.GameObjects.Container | null = null;
  private busy = false;
  private starting = false;
  private inRoom = false;
  private off: (() => void)[] = [];

  constructor() {
    super('Lobby');
  }

  create(): void {
    this.net = null;
    this.panel = null;
    this.busy = false;
    this.starting = false;
    this.inRoom = false;
    this.off = [];
    const touch = isTouch();
    this.cameras.main.setBackgroundColor(THEMES[0].bg);
    this.input.setDefaultCursor(touch ? 'default' : 'auto');
    this.add.image(GW / 2, GH / 2, 'vignette').setDisplaySize(GW, GH).setDepth(1);
    this.add.image(GW / 2, 330, 'light').setScale(7, 3.2).setTint(0xff9a50).setAlpha(0.18).setBlendMode(Phaser.BlendModes.ADD);

    label(this, GW / 2, touch ? 130 : 150, 'VERSUS', touch ? 180 : 170, CREAM, '700', 24).setDepth(10).setShadow(0, 10, '#000000', 24, false, true);
    this.add.rectangle(GW / 2, touch ? 242 : 262, 560, 5, 0xd8452f).setDepth(10);
    const bet = session.stake > 0n ? `BET ${formatUsdc(session.stake)} USDC` : 'FREE PLAY';
    label(this, GW / 2, touch ? 296 : 306, `STEP 3 OF 3  ·  ${bet}  ·  ${AVATARS[session.avatar].name}`, touch ? 30 : 22, session.stake > 0n ? GOLD : DIM, '500', 6).setDepth(10);

    this.status = label(this, GW / 2, touch ? 1035 : 830, '', touch ? 40 : 28, CREAM, '500', 3).setDepth(10);
    this.codeText = label(this, GW / 2, touch ? 590 : 560, '', touch ? 190 : 160, GOLD, '700', 30).setDepth(10)
      .setShadow(0, 8, '#000000', 18, false, true);

    this.showMenu();

    const kb = this.input.keyboard!;
    kb.on('keydown-ESC', () => this.back());
    this.events.once('shutdown', () => {
      kb.off('keydown-ESC');
      for (const f of this.off) f();
      this.off = [];
      if (!this.starting) this.net?.send({ t: 'cancel' });
    });
    audio.setIntensity(0);
    void this.attach();
  }

  /** Reuse (or re-open) the relay connection and listen to it. */
  private async attach(): Promise<void> {
    try {
      const net = await ensureNet();
      if (session.info?.escrow) await ensureAuth(net);
      this.net = net;
      this.off.push(net.on((m) => this.onMsg(m)));
      this.off.push(net.onClose(() => {
        if (this.starting || !this.scene.isActive()) return;
        this.say('Lost connection to the server.', RED);
        this.showMenu();
      }));
    } catch (err) {
      this.say((err as Error).message || 'Could not reach the game server.', RED);
    }
  }

  private showMenu(): void {
    this.panel?.destroy();
    const touch = isTouch();
    const o = touch ? { w: 760, h: 150, size: 54 } : { w: 460, h: 78, size: 34 };
    const y0 = touch ? 520 : 500;
    const gap = touch ? 190 : 100;
    this.panel = this.add.container(0, 0, [
      makeButton(this, GW / 2, y0, 'CREATE ROOM', () => this.create_(), { ...o, primary: true }).c,
      makeButton(this, GW / 2, y0 + gap, 'JOIN ROOM', () => this.join(), o).c,
      makeButton(this, GW / 2, y0 + gap * 2, 'BACK', () => this.back(), o).c,
    ]).setDepth(10);
    this.codeText.setText('');
    this.inRoom = false;
    this.status.setY(touch ? 1035 : 830);
    this.status.setFontSize(touch ? 34 : 24).setColor(DIM);
    this.status.setText(session.stake > 0n
      ? 'One of you creates a room, the other joins with its code. Both put up the same bet.'
      : 'Play a friend online. One creates a room, the other joins with its code.');
  }

  private say(text: string, colour = CREAM): void {
    if (this.codeText.text) this.status.setY(isTouch() ? 800 : 690);
    this.status.setText(text).setColor(colour).setFontSize(isTouch() ? 40 : 30);
  }

  /** A single button under a message while we wait for something. */
  private waiting(buttonLabel: string, onClick: () => void): void {
    this.panel?.destroy();
    const touch = isTouch();
    this.panel = this.add.container(0, 0, [
      makeButton(this, GW / 2, touch ? 900 : 800, buttonLabel, onClick, touch ? { w: 560, h: 130, size: 44 } : { w: 340 }).c,
    ]).setDepth(10);
  }

  // ------------------------------------------------------------ actions

  private create_(): void {
    if (this.busy || !this.net) return;
    this.busy = true;
    this.say('Creating room…');
    this.waiting('CANCEL', () => this.cancel());
    this.net.send({ t: 'create', stake: session.stake.toString(), avatar: session.avatar });
  }

  private join(): void {
    if (this.busy || !this.net) return;
    const raw = window.prompt('Enter the room code from your friend:', '');
    const code = (raw ?? '').trim().toUpperCase();
    if (!code) return;
    this.busy = true;
    this.say(`Joining ${code}…`);
    this.waiting('CANCEL', () => this.cancel());
    this.net.send({ t: 'join', code, avatar: session.avatar });
  }

  private cancel(): void {
    this.net?.send({ t: 'cancel' });
    this.busy = false;
    this.showMenu();
    if (session.stake > 0n && this.inRoom) this.say('Room closed. Your bet is on its way back to your wallet.', GOLD);
  }

  /** The relay wants the stake: confirm (joiners), pay from the wallet, then show the receipt to the relay. */
  private async payStake(m: NetMsg): Promise<void> {
    const amount = BigInt(String(m.amount));
    const treasury = String(m.treasury);
    const api = wallet();
    if (!api?.authenticated) {
      this.net?.send({ t: 'cancel' });
      this.busy = false;
      this.showMenu();
      return this.say('Sign in first.', RED);
    }
    if (m.joining) {
      // the joiner learns the bet only now: let them accept or walk away
      this.say(`The bet in this room is ${formatUsdc(amount)} USDC.`, GOLD);
      const ok = await new Promise<boolean>((resolve) => {
        const touch = isTouch();
        const o = touch ? { w: 560, h: 130, size: 44 } : { w: 340 };
        this.panel?.destroy();
        this.panel = this.add.container(0, 0, [
          makeButton(this, GW / 2 - (touch ? 300 : 190), touch ? 900 : 800, `PAY ${formatUsdc(amount)} & JOIN`, () => resolve(true), { ...o, primary: true }).c,
          makeButton(this, GW / 2 + (touch ? 300 : 190), touch ? 900 : 800, 'LEAVE', () => resolve(false), o).c,
        ]).setDepth(10);
      });
      if (!ok) return this.cancel();
      this.waiting('CANCEL', () => this.cancel());
    }
    this.say('Confirm the bet in your wallet…', CREAM);
    let hash: string | null = null;
    let sentHash: string | null = null;
    try {
      hash = await api.pay(treasury, amount, (h) => {
        sentHash = h;
        this.say('Payment sent. Waiting for it to confirm…', CREAM);
      });
    } catch (err) {
      const message = (err as Error).message || 'Payment cancelled.';
      if (sentHash) {
        // the transfer already left the wallet: tell the relay so it can match it or refund it
        this.say(`${message} Checking whether your payment went through…`, GOLD);
        await this.reportPayment(sentHash);
        return;
      }
      this.net?.send({ t: 'cancel' });
      this.busy = false;
      this.showMenu();
      return this.say(message, RED);
    }
    this.say('Verifying your bet…', CREAM);
    await this.reportPayment(hash);
  }

  /** Tell the relay about a payment. If the connection dropped meanwhile, reconnect first: the relay will
   *  refund a payment for a room that no longer exists. */
  private async reportPayment(txHash: string): Promise<void> {
    try {
      let net = this.net;
      if (!net?.open) {
        this.say('Reconnecting to confirm your payment…', GOLD);
        net = await ensureNet();
        if (session.info?.escrow) await ensureAuth(net);
        this.net = net;
        for (const f of this.off) f();
        this.off = [net.on((m) => this.onMsg(m))];
      }
      net.send({ t: 'paid', txHash });
    } catch (err) {
      this.busy = false;
      this.say(`Your payment was sent but we could not confirm it (${(err as Error).message}). Transaction: ${txHash}`, RED);
    }
  }

  // ------------------------------------------------------------ relay messages

  private onMsg(m: NetMsg): void {
    switch (m.t) {
      case 'pay':
        this.inRoom = true;
        void this.payStake(m);
        break;
      case 'created':
        this.inRoom = true;
        this.busy = false;
        this.codeText.setText(String(m.code));
        this.say(session.stake > 0n ? 'Bet locked. Share this code and wait for your opponent…' : 'Share this code. Waiting for your opponent…');
        this.waiting('CANCEL', () => this.cancel());
        break;
      case 'error':
        this.busy = false;
        this.showMenu();
        this.say(String(m.msg ?? 'Something went wrong.'), RED);
        break;
      case 'left':
        this.busy = false;
        this.showMenu();
        this.say('The room closed.', DIM);
        break;
      case 'settled':
        this.say('Your bet is being returned to your wallet.', GOLD);
        break;
      case 'start': {
        this.starting = true;
        this.say('Opponent found!', GOLD);
        const net = this.net!;
        const slot = (m.slot === 1 ? 1 : 0) as 0 | 1;
        this.cameras.main.fadeOut(240, 5, 4, 5);
        this.cameras.main.once('camerafadeoutcomplete', () => {
          this.scene.start('Game', {
            versus: {
              net, slot, seed: Number(m.seed) || 1, stake: String(m.stake ?? '0'),
              avatar: Number(m.avatar) || 0, oppAvatar: Number(m.oppAvatar) || 0,
            },
          });
        });
        break;
      }
    }
  }

  private back(): void {
    if (this.starting) return;
    this.scene.start('Avatar');
  }
}

