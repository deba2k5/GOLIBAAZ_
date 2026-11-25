import Phaser from 'phaser';
import { GH, GW } from '../config';
import { isTouch } from '../core/device';
import type { GameScene } from '../scenes/GameScene';
import { CREAM, DIM, GOLD, RED, label, makeButton } from '../scenes/widgets';
import { formatUsdc } from '../web3/arc';
import { WIN_SCORE, type Phase } from './versus';

/** Score, round banner and end-of-match buttons for an online 1v1. Sits on top of the game and UI scenes. */
export class VsHud extends Phaser.Scene {
  private g!: GameScene;
  private score!: Phaser.GameObjects.Text;
  private sub!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;
  private money!: Phaser.GameObjects.Text;
  private oppHp!: Phaser.GameObjects.Graphics;
  private buttons: Phaser.GameObjects.Container | null = null;
  private shown = '';
  private lastPhase: Phase | '' = '';
  private rematch!: ReturnType<typeof makeButton>;

  constructor() {
    super('VsHud');
  }

  create(): void {
    this.g = this.scene.get('Game') as GameScene;
    this.buttons = null;
    this.shown = '';
    this.lastPhase = '';
    const touch = isTouch();
    const top = touch ? 54 : 44;

    this.score = label(this, GW / 2, top, '', touch ? 64 : 52, CREAM, '700', 6).setShadow(0, 4, '#000000', 10, false, true);
    this.sub = label(this, GW / 2, top + (touch ? 62 : 50), '', touch ? 28 : 22, DIM, '500', 4).setShadow(0, 3, '#000000', 8, false, true);
    this.banner = label(this, GW / 2, GH * 0.36, '', touch ? 150 : 170, CREAM, '700', 12)
      .setShadow(0, 8, '#000000', 20, false, true).setAlpha(0);
    this.money = label(this, GW / 2, GH * 0.52, '', touch ? 46 : 36, GOLD, '700', 4).setShadow(0, 4, '#000000', 10, false, true);
    this.oppHp = this.add.graphics();
    this.input.setDefaultCursor(touch ? 'default' : 'none');
  }

  update(): void {
    const v = this.g?.versus;
    if (!v) return;

    this.score.setText(`YOU  ${v.score.me}  :  ${v.score.opp}  OPPONENT`);
    const pot = v.stake > 0n ? `   ·   POT ${formatUsdc(v.stake * 2n)} USDC` : '';
    this.sub.setText(`ROUND ${v.round}   ·   FIRST TO ${WIN_SCORE}${pot}`);
    this.money.setText(v.phase === 'over' || v.phase === 'left' ? this.moneyLine(v) : '');

    // opponent health pips under the score
    const g = this.oppHp;
    g.clear();
    const max = 10;
    const hp = Math.max(0, Math.min(max, v.remote.hp));
    const w = 22;
    const gap = 6;
    const x0 = GW / 2 - ((max * (w + gap)) - gap) / 2;
    const y = (isTouch() ? 54 + 62 : 44 + 50) + 30;
    for (let i = 0; i < max; i++) {
      g.fillStyle(i < hp ? 0xd8452f : 0x2a2522, 0.95).fillRoundedRect(x0 + i * (w + gap), y, w, 10, 3);
    }

    if (v.banner !== this.shown) {
      this.shown = v.banner;
      this.banner.setText(v.banner);
      this.tweens.killTweensOf(this.banner);
      if (v.banner) {
        const colour = v.banner === 'VICTORY' || v.banner === 'ROUND WON' ? GOLD : v.banner === 'DEFEAT' || v.banner === 'ROUND LOST' || v.banner === 'OPPONENT LEFT' ? RED : CREAM;
        this.banner.setColor(colour).setAlpha(0).setScale(1.25);
        this.tweens.add({ targets: this.banner, alpha: 1, scale: 1, duration: 220, ease: 'Back.easeOut' });
      } else {
        this.tweens.add({ targets: this.banner, alpha: 0, duration: 200 });
      }
    }

    if (v.phase !== this.lastPhase) {
      this.lastPhase = v.phase;
      this.buttons?.destroy();
      this.buttons = null;
      if (v.phase === 'over') this.showButtons(v.stake === 0n);
      else if (v.phase === 'left') this.showButtons(false);
    }
    if (v.phase === 'over' && this.rematch) {
      this.rematch.setLabel(v.myAgain ? 'WAITING FOR OPPONENT…' : v.oppAgain ? 'REMATCH (THEY WANT ONE)' : 'REMATCH');
    }
  }

  /** What happened to the bet, once the relay has said so. */
  private moneyLine(v: NonNullable<GameScene['versus']>): string {
    if (v.stake <= 0n) return '';
    if (!v.settle) return 'SETTLING THE BET…';
    const amt = formatUsdc(v.settle.amount);
    if (v.settle.outcome === 'win') return `YOU WIN ${amt} USDC  ·  PAYOUT SENT TO YOUR WALLET`;
    if (v.settle.outcome === 'lose') return 'YOU LOST YOUR BET';
    return `BET REFUNDED (${amt} USDC)  ·  RESULTS DID NOT MATCH OR A PLAYER LEFT`;
  }

  private showButtons(rematch: boolean): void {
    const v = this.g.versus!;
    const touch = isTouch();
    const items: Phaser.GameObjects.GameObject[] = [];
    const y = GH * 0.62;
    const o = touch ? { w: 620, h: 140, size: 46 } : { w: 440, h: 74, size: 32 };
    if (rematch) {
      this.rematch = makeButton(this, GW / 2, y, 'REMATCH', () => v.askRematch(), { ...o, primary: true });
      items.push(this.rematch.c);
    }
    items.push(makeButton(this, GW / 2, y + (touch ? 170 : 92), 'MAIN MENU', () => v.leave(), o).c);
    this.buttons = this.add.container(0, 0, items).setDepth(10);
    this.input.setDefaultCursor('default');
  }
}
