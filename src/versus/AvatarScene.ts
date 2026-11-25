import Phaser from 'phaser';
import { GH, GW, THEMES } from '../config';
import { audio } from '../core/audio';
import { isTouch } from '../core/device';
import { CREAM, DIM, GOLD, label, makeButton } from '../scenes/widgets';
import { formatUsdc } from '../web3/arc';
import { AVATARS } from './avatars';
import { session } from './session';

/** Step 2 of versus: pick the skin your opponent will see you in. */
export class AvatarScene extends Phaser.Scene {
  private cells: { ring: Phaser.GameObjects.Arc; body: Phaser.GameObjects.Image; gun: Phaser.GameObjects.Image }[] = [];
  private picked = 0;
  private nameText!: Phaser.GameObjects.Text;
  private big!: Phaser.GameObjects.Image;
  private bigGun!: Phaser.GameObjects.Image;

  constructor() {
    super('Avatar');
  }

  create(): void {
    this.cells = [];
    this.picked = session.avatar;
    const touch = isTouch();
    this.cameras.main.setBackgroundColor(THEMES[0].bg);
    this.input.setDefaultCursor(touch ? 'default' : 'auto');
    this.add.image(GW / 2, GH / 2, 'vignette').setDisplaySize(GW, GH).setDepth(1);
    this.add.image(GW / 2, 300, 'light').setScale(7, 3.2).setTint(0xff9a50).setAlpha(0.18).setBlendMode(Phaser.BlendModes.ADD);

    label(this, GW / 2, touch ? 110 : 130, 'CHOOSE YOUR AVATAR', touch ? 110 : 120, CREAM, '700', 14).setDepth(10).setShadow(0, 10, '#000000', 24, false, true);
    this.add.rectangle(GW / 2, touch ? 195 : 214, 560, 5, 0xd8452f).setDepth(10);
    const bet = session.stake > 0n ? `BET ${formatUsdc(session.stake)} USDC` : 'FREE PLAY';
    label(this, GW / 2, touch ? 246 : 258, `STEP 2 OF 3  ·  ${bet}`, touch ? 30 : 22, session.stake > 0n ? GOLD : DIM, '500', 8).setDepth(10);

    // big preview
    const py = touch ? 450 : 440;
    this.big = this.add.image(GW / 2 - 18, py, 'player').setDepth(10).setScale(touch ? 3.6 : 3);
    this.bigGun = this.add.image(GW / 2 + 40, py, 'w_pistol').setDepth(10).setScale(touch ? 1.7 : 1.4);
    this.nameText = label(this, GW / 2, py + (touch ? 175 : 150), '', touch ? 56 : 42, GOLD, '700', 8).setDepth(10);

    // swatches
    const cols = 4;
    const gx = touch ? 250 : 200;
    const gy = touch ? 150 : 130;
    const y0 = touch ? 740 : 690;
    AVATARS.forEach((a, i) => {
      const x = GW / 2 + ((i % cols) - (cols - 1) / 2) * gx;
      const y = y0 + Math.floor(i / cols) * gy;
      const ring = this.add.circle(x, y, touch ? 62 : 50, 0x1c1917, 1).setStrokeStyle(4, 0x6b6055).setDepth(10);
      const body = this.add.image(x, y, 'player').setTint(a.tint).setScale(touch ? 1.15 : 0.95).setDepth(11);
      const gun = this.add.image(x + (touch ? 30 : 24), y, 'w_pistol').setScale(touch ? 0.5 : 0.4).setDepth(11);
      ring.setInteractive({ useHandCursor: true }).on('pointerdown', () => this.pick(i));
      this.cells.push({ ring, body, gun });
    });
    this.pick(this.picked, true);

    const ob = touch ? { w: 520, h: 130, size: 44 } : { w: 340, h: 74, size: 30 };
    const by = touch ? 1010 : 960;
    makeButton(this, touch ? GW / 2 - 290 : GW / 2 - 200, by, 'BACK', () => this.back(), { ...ob, w: touch ? 400 : 240 }).c.setDepth(10);
    makeButton(this, touch ? GW / 2 + 250 : GW / 2 + 160, by, 'NEXT  ·  ROOM', () => this.next(), { ...ob, primary: true }).c.setDepth(10);

    const kb = this.input.keyboard!;
    kb.on('keydown-LEFT', () => this.pick((this.picked + AVATARS.length - 1) % AVATARS.length));
    kb.on('keydown-RIGHT', () => this.pick((this.picked + 1) % AVATARS.length));
    kb.on('keydown-ESC', () => this.back());
    kb.on('keydown-ENTER', () => this.next());
    this.events.once('shutdown', () => {
      kb.off('keydown-LEFT');
      kb.off('keydown-RIGHT');
      kb.off('keydown-ESC');
      kb.off('keydown-ENTER');
    });
    audio.setIntensity(0);
  }

  private pick(i: number, silent = false): void {
    this.picked = i;
    session.avatar = i;
    const a = AVATARS[i];
    this.big.setTint(a.tint);
    this.nameText.setText(a.name);
    this.cells.forEach((c, k) => c.ring.setStrokeStyle(k === i ? 7 : 4, k === i ? 0xe8c05a : 0x6b6055));
    if (!silent) audio.play('hover');
  }

  private next(): void {
    audio.play('click');
    this.scene.start('Lobby');
  }

  private back(): void {
    this.scene.start(session.info?.escrow ? 'Bet' : 'Menu');
  }
}
