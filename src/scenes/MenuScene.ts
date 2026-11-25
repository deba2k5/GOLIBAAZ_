import Phaser from 'phaser';
import { GH, GW, THEMES } from '../config';
import { audio } from '../core/audio';
import { isTouch, onTouchChange } from '../core/device';
import { enterFullscreen, fullscreenSupported, inGesture, isFullscreen, onFullscreenChange, toggleFullscreen } from '../core/fullscreen';
import { loadSave, writeSave } from '../core/save';
import type { RoomNode } from '../world/floorgen';
import { Room } from '../world/room';
import { generateRoom } from '../world/roomgen';
import { CREAM, DIM, GOLD, label, makeButton, makeStepper } from './widgets';

interface Mote {
  img: Phaser.GameObjects.Image;
  vx: number;
  vy: number;
  phase: number;
}

export class MenuScene extends Phaser.Scene {
  private room: Room | null = null;
  private motes: Mote[] = [];
  private cursor!: Phaser.GameObjects.Graphics;
  private panel: Phaser.GameObjects.Container | null = null;
  /** Layout mode this scene was built for. */
  private touch = false;
  /** Input mode changed while a panel was open: rebuild once it closes. */
  private relayout = false;
  private starting = false;

  constructor() {
    super('Menu');
  }

  create(): void {
    this.motes = [];
    this.panel = null;
    this.relayout = false;
    this.starting = false;
    this.touch = isTouch();
    const touch = this.touch;
    this.cameras.main.setBackgroundColor(0x0b0908);
    this.input.setDefaultCursor(touch ? 'default' : 'none');

    // A real generated room as the backdrop
    const node: RoomNode = {
      id: 0, gx: 0, gy: 0, type: 'combat', doors: {}, depth: 0, cleared: true, visited: true, seen: true,
      seed: Math.floor(Math.random() * 1e9),
    };
    node.layout = generateRoom(node, 0, [30, 17]);
    this.room = new Room(this, node, THEMES[0], 0);
    for (const l of this.room.lamps) l.glow.setAlpha(0.3).setScale(2.2).setDepth(3);
    this.add.rectangle(GW / 2, GH / 2, GW, GH, 0x070605, 0.62).setDepth(2);
    this.add.image(GW / 2, GH / 2, 'vignette').setDisplaySize(GW, GH).setDepth(4);

    // Touch layout: everything is drawn at roughly 0.4x on a phone, so text and targets are larger
    // and the two secondary buttons sit side by side to keep it all inside 1080px.
    const L = touch
      ? { titleY: 200, titleSize: 220, barY: 306, barW: 640, subY: 362, subSize: 38, startY: 490, rowY: 810, bestY: 945, bestSize: 36, hintY: 1018 }
      : { titleY: 300, titleSize: 300, barY: 446, barW: 760, subY: 488, subSize: 32, startY: 640, rowY: 0, bestY: 975, bestSize: 20, hintY: GH - 30 };

    // a pool of warm light behind the title
    this.add.image(GW / 2, L.titleY + 30, 'light').setScale(7, 3.2).setTint(0xff9a50).setAlpha(0.2).setBlendMode(Phaser.BlendModes.ADD).setDepth(4);

    for (let i = 0; i < 46; i++) {
      const img = this.add.image(Math.random() * GW, Math.random() * GH, 'soft').setDepth(5)
        .setScale(0.04 + Math.random() * 0.1).setAlpha(0.1 + Math.random() * 0.25).setTint(0xffd9a0).setBlendMode(Phaser.BlendModes.ADD);
      this.motes.push({ img, vx: -8 + Math.random() * 16, vy: -14 - Math.random() * 18, phase: Math.random() * 10 });
    }

    // ---- title
    const title = label(this, GW / 2, L.titleY, 'GOLIBAAZ', L.titleSize, CREAM, '700', touch ? 26 : 34).setDepth(10);
    title.setShadow(0, 10, '#000000', 24, false, true);
    const bar = this.add.rectangle(GW / 2, L.barY, L.barW, 5, 0xd8452f).setDepth(10).setScale(0, 1);
    const sub = label(this, GW / 2, L.subY, 'DODGE.  SHOOT.  DESCEND.', L.subSize, DIM, '500', 14).setDepth(10);
    title.setAlpha(0).setScale(1.08);
    sub.setAlpha(0);
    this.tweens.add({ targets: title, alpha: 1, scale: 1, duration: 900, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: bar, scaleX: 1, duration: 700, delay: 350, ease: 'Cubic.easeOut' });
    this.tweens.add({ targets: sub, alpha: 1, duration: 600, delay: 700 });

    // ---- buttons
    const save = loadSave();
    const run = (p?: Phaser.Input.Pointer) => this.startRun(p);
    const buttons = touch
      ? [
        makeButton(this, GW / 2, L.startY, 'START RUN', run, { primary: true, w: 760, h: 160, size: 58 }),
        makeButton(this, GW / 2, 660, 'VERSUS  ·  ONLINE 1V1', () => this.startVersus(), { w: 760, h: 130, size: 44 }),
        makeButton(this, GW / 2 - 300, L.rowY, 'HOW TO PLAY', () => this.showHelp(), { w: 560, h: 150, size: 44 }),
        makeButton(this, GW / 2 + 300, L.rowY, 'OPTIONS', () => this.showOptions(), { w: 560, h: 150, size: 44 }),
      ]
      : [
        makeButton(this, GW / 2, 620, 'START RUN', run, { primary: true, w: 440, h: 78, size: 36 }),
        makeButton(this, GW / 2, 712, 'VERSUS  ·  ONLINE 1V1', () => this.startVersus(), { w: 440 }),
        makeButton(this, GW / 2, 796, 'HOW TO PLAY', () => this.showHelp(), { w: 440 }),
        makeButton(this, GW / 2, 880, 'OPTIONS', () => this.showOptions(), { w: 440 }),
      ];
    buttons.forEach(({ c }, i) => {
      c.setDepth(10).setAlpha(0);
      this.tweens.add({ targets: c, alpha: 1, duration: 400, delay: 900 + i * 120 });
    });

    const gap = touch ? '   ·   ' : '     ·     ';
    const best = save.bestScore > 0
      ? `BEST SCORE  ${save.bestScore.toLocaleString()}${gap}DEEPEST FLOOR  ${save.bestFloor}${gap}VICTORIES  ${save.wins}`
      : 'Three floors. Three bosses. One life.';
    label(this, GW / 2, L.bestY, best, L.bestSize, save.bestScore > 0 ? GOLD : DIM, '500', 4).setDepth(10);
    if (touch) {
      label(this, GW / 2, L.hintY, 'Left thumb moves   ·   right thumb aims and fires', 40, DIM, '400', 2)
        .setDepth(10).setAlpha(0.85).setShadow(0, 3, '#000000', 8, false, true);
    } else {
      label(this, GW / 2, L.hintY, 'Press ENTER to start', 18, DIM, '400', 4).setDepth(10).setAlpha(0.7);
    }

    this.cursor = this.add.graphics().setDepth(1000).setVisible(!touch);

    const kb = this.input.keyboard!;
    kb.on('keydown-ENTER', () => {
      if (!this.panel) this.startRun();
    });
    kb.on('keydown-ESC', () => this.closePanel());
    this.input.once('pointerdown', () => audio.unlock());
    // A hybrid laptop can switch to touch mid-menu: rebuild for the new mode, but let the tap
    // that caused the switch finish first, and never yank an open panel or a starting run.
    const offTouch = onTouchChange((t) => {
      if (t === this.touch) return;
      this.time.delayedCall(0, () => {
        if (this.starting || isTouch() === this.touch) return;
        if (this.panel) this.relayout = true;
        else this.scene.restart();
      });
    });
    this.events.once('shutdown', () => {
      offTouch();
      kb.off('keydown-ENTER');
      kb.off('keydown-ESC');
      this.room?.destroy();
      this.room = null;
    });
    audio.setIntensity(0);
    audio.startMusic();
  }

  private startRun(pointer?: Phaser.Input.Pointer): void {
    if (this.starting) return;
    this.starting = true;
    audio.unlock();
    audio.play('click');
    // On phones, go fullscreen and lock to landscape (Android). The browser only accepts this
    // from the touchend that follows the tap; it fails silently where unsupported (iPhone).
    if (pointer?.wasTouch) inGesture(enterFullscreen, true);
    const cam = this.cameras.main;
    cam.fadeOut(260, 5, 4, 5);
    cam.once('camerafadeoutcomplete', () => this.scene.start('Game', {}));
  }

  private startVersus(): void {
    if (this.starting) return;
    this.starting = true;
    audio.unlock();
    const cam = this.cameras.main;
    cam.fadeOut(200, 5, 4, 5);
    cam.once('camerafadeoutcomplete', () => this.scene.start('Bet'));
  }

  private closePanel(): void {
    this.panel?.destroy();
    this.panel = null;
    if (this.relayout && !this.starting) {
      this.relayout = false;
      this.scene.restart();
    }
  }

  private openPanel(title: string, h: number, build: (items: Phaser.GameObjects.GameObject[], top: number) => void): void {
    this.closePanel();
    const touch = this.touch;
    const w = touch ? 1640 : 1080;
    const top = GH / 2 - h / 2;
    const dim = this.add.rectangle(GW / 2, GH / 2, GW, GH, 0x070605, 0.8).setInteractive();
    const bg = this.add.graphics();
    bg.fillStyle(0x1a1614, 0.98).fillRoundedRect(GW / 2 - w / 2, top, w, h, 12);
    bg.lineStyle(2, 0x6b6055, 1).strokeRoundedRect(GW / 2 - w / 2, top, w, h, 12);
    const items: Phaser.GameObjects.GameObject[] = [dim, bg, label(this, GW / 2, top + 70, title, touch ? 64 : 56, CREAM, '700', 10)];
    build(items, top);
    items.push(touch
      ? makeButton(this, GW / 2, top + h - 105, 'BACK', () => this.closePanel(), { w: 440, h: 150, size: 44 }).c
      : makeButton(this, GW / 2, top + h - 70, 'BACK', () => this.closePanel(), { w: 300 }).c);
    this.panel = this.add.container(0, 0, items).setDepth(100);
  }

  private showHelp(): void {
    if (this.touch) {
      this.showTouchHelp();
      return;
    }
    const rows: [string, string][] = [
      ['W A S D', 'Move'],
      ['MOUSE', 'Aim'],
      ['LEFT CLICK', 'Shoot (hold to keep firing)'],
      ['SPACE  /  RIGHT CLICK', 'Dodge roll: you cannot be hit while rolling'],
      ['R', 'Reload. Tap again in the gold zone for a perfect reload'],
      ['Q', 'Blast: wipes every enemy bullet on screen'],
      ['E', 'Interact: open chests, buy, pick up, descend'],
      ['1 - 4  /  WHEEL', 'Switch weapon'],
      ['ESC', 'Pause'],
    ];
    this.openPanel('HOW TO PLAY', 800, (items, top) => {
      rows.forEach(([k, v], i) => {
        const y = top + 160 + i * 52;
        items.push(label(this, GW / 2 - 470, y, k, 24, GOLD, '700', 3).setOrigin(0, 0.5));
        items.push(label(this, GW / 2 - 130, y, v, 24, CREAM, '400').setOrigin(0, 0.5));
      });
      items.push(label(this, GW / 2, top + 650,
        'Clear every room, find the boss, take the stairs. Kill quickly to build a combo for more coin.', 22, DIM, '400', 1));
    });
  }

  private showTouchHelp(): void {
    const rows: [string, string][] = [
      ['LEFT THUMB', 'Drag anywhere on the left to move'],
      ['RIGHT THUMB', 'Drag on the right to aim. Fires while held'],
      ['ROLL', 'Dodge roll: you cannot be hit while rolling'],
      ['RELOAD', 'Tap again in the gold zone for a perfect reload'],
      ['BLAST', 'Wipes every enemy bullet on screen'],
      ['ACTION', 'Appears by chests, shops, pickups and stairs'],
      ['WEAPON PANEL', 'Tap it to switch guns'],
      ['PAUSE', 'The button at the top of the screen'],
    ];
    this.openPanel('HOW TO PLAY', 1020, (items, top) => {
      rows.forEach(([k, v], i) => {
        const y = top + 175 + i * 74;
        items.push(label(this, GW / 2 - 560, y, k, 40, GOLD, '700', 3).setOrigin(0, 0.5));
        items.push(label(this, GW / 2 - 190, y, v, 40, CREAM, '400').setOrigin(0, 0.5));
      });
      items.push(label(this, GW / 2, top + 780, 'Clear every room, find the boss, take the stairs.', 40, DIM, '400', 1));
    });
  }

  private showOptions(): void {
    const save = loadSave();
    const touch = this.touch;
    const fs = touch && fullscreenSupported();
    const h = touch ? (fs ? 1000 : 840) : 520;
    const rowY = touch ? [200, 365, 530] : [180, 250, 320];
    const sx = touch ? GW / 2 - 90 : GW / 2 - 10;
    this.openPanel('OPTIONS', h, (items, top) => {
      items.push(makeStepper(this, sx, top + rowY[0], 'SOUND', () => save.sfxVol, (v) => {
        save.sfxVol = v;
        writeSave({ sfxVol: v });
        audio.setSfxVol(v);
      }, { touch }));
      items.push(makeStepper(this, sx, top + rowY[1], 'MUSIC', () => save.musicVol, (v) => {
        save.musicVol = v;
        writeSave({ musicVol: v });
        audio.setMusicVol(v);
      }, { touch }));
      items.push(makeStepper(this, sx, top + rowY[2], 'SCREEN SHAKE', () => save.shake, (v) => {
        save.shake = v;
        writeSave({ shake: v });
      }, { touch }));
      if (fs) {
        const text = () => `FULLSCREEN:  ${isFullscreen() ? 'ON' : 'OFF'}`;
        const btn = makeButton(this, GW / 2, top + 700, text(), (p) => inGesture(toggleFullscreen, p.wasTouch), { w: 640, h: 150, size: 44 });
        const off = onFullscreenChange(() => {
          if (btn.c.active) btn.setLabel(text());
        });
        btn.c.once('destroy', off);
        items.push(btn.c);
      }
    });
  }

  update(time: number, delta: number): void {
    const dt = delta / 1000;
    for (const m of this.motes) {
      m.img.x += (m.vx + Math.sin(time * 0.001 + m.phase) * 10) * dt;
      m.img.y += m.vy * dt;
      if (m.img.y < -20) {
        m.img.y = GH + 20;
        m.img.x = Math.random() * GW;
      }
    }
    this.room?.update(dt, time);
    if (this.room) for (const l of this.room.lamps) l.glow.setAlpha(l.glow.alpha * 1.5);
    this.cursor.clear();
    if (this.touch) return;
    const p = this.input.activePointer;
    this.cursor.fillStyle(0x17120f, 1).fillCircle(p.x, p.y, 9);
    this.cursor.fillStyle(0xf3e6c8, 1).fillCircle(p.x, p.y, 6);
  }
}
