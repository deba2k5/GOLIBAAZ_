import Phaser from 'phaser';
import { DEPTH, GH, GW, THEMES, TILE, TOUCH_BOSS_ZOOM, TOUCH_ZOOM, type Theme, ZOOM } from '../config';
import { audio } from '../core/audio';
import { Bot } from '../core/bot';
import { isTouch } from '../core/device';
import { TAU, angDiff, clamp, damp } from '../core/math';
import { RNG, rnd, rndInt } from '../core/rng';
import { loadSave, writeSave } from '../core/save';
import { BOSSES } from '../entities/boss';
import { Bullets } from '../entities/bullets';
import { Enemies, type Enemy } from '../entities/enemies';
import type { EnemyType } from '../entities/enemyDefs';
import { Pickups, type Pickup } from '../entities/pickups';
import { type Controls, Player, emptyControls } from '../entities/player';
import { type Stats, UPGRADE_MAP, type UpgradeDef, computeStats, rollUpgrades } from '../entities/upgrades';
import { WEAPONS, WEAPON_IDS, makeWeapon } from '../entities/weapons';
import { Fx } from '../gfx/fx';
import { DIRS, type Dir, type FloorPlan, OPP, type RoomNode, generateFloor } from '../world/floorgen';
import { type Prop, Room } from '../world/room';
import { Versus, type VersusInit, arenaPlan } from '../versus/versus';
import { generateWaves } from '../world/roomgen';

export interface RunState {
  seed: number;
  floorIndex: number;
  loop: number;
  plan: FloorPlan;
  roomId: number;
  coins: number;
  coinsEarned: number;
  score: number;
  kills: number;
  combo: number;
  comboT: number;
  comboMax: number;
  bestCombo: number;
  time: number;
  upgrades: Record<string, number>;
  stats: Stats;
  damageDealt: number;
  damageTaken: number;
  roomsCleared: number;
  shots: number;
  rolls: number;
  perfects: number;
  bossesKilled: number;
  over: boolean;
  won: boolean;
}

export interface StartData {
  seed?: number;
  floor?: number;
  bot?: boolean;
  god?: boolean;
  speed?: number;
  weapons?: string[];
  room?: string;
  /** Online 1v1: a connected relay, which side of the arena you spawn on, and the shared seed. */
  versus?: VersusInit;
}

/** How quickly the camera eases between zoom levels (touch: into and out of a boss fight). */
const ZOOM_EASE = 2.5;
/** Touch aim: how far ahead of the player the aim point sits (world px). Drives the camera lean. */
export const TOUCH_AIM_LEAD = 520;
/** Touch aim assist: half-angle of the cone around the stick direction that can snap onto an enemy (radians). */
export const AIM_ASSIST_CONE = 0.2;
/** Touch aim assist: enemies further than this (world px) are ignored. */
export const AIM_ASSIST_RANGE = 950;
/** Touch aim assist: fraction of the angle to the chosen enemy that is applied (0 = off, 1 = hard lock). */
export const AIM_ASSIST_STRENGTH = 0.6;

/** Written by the on-screen touch controls in UIScene, read by readInput() in touch mode. */
export interface TouchState {
  /** Analog move vector from the move stick, length 0..1. */
  mx: number;
  my: number;
  /** Raw aim-stick direction (radians), valid while `aiming`. */
  aimAng: number;
  /** The aim stick is held past its dead zone. */
  aiming: boolean;
  /** The aim stick is held past the fire threshold. */
  fire: boolean;
}

export type TouchAction = 'roll' | 'reload' | 'blank' | 'interact' | 'pause' | 'cycle';
const TOUCH_KEYS: Record<Exclude<TouchAction, 'cycle'>, string> = {
  roll: 'space', reload: 'r', blank: 'q', interact: 'e', pause: 'esc',
};

interface Timer {
  t: number;
  fn: () => void;
}

interface Transition {
  t: number;
  phase: 0 | 1;
  mid: () => void;
}

export class GameScene extends Phaser.Scene {
  run!: RunState;
  room!: Room;
  player!: Player;
  enemies!: Enemies;
  bullets!: Bullets;
  fx!: Fx;
  pickups!: Pickups;
  theme: Theme = THEMES[0];
  ctrl: Controls = emptyControls();
  paused = false;
  /** Set while a modal (upgrade choice, game over) is up: gameplay holds still. */
  modal = false;
  bossEnemy: Enemy | null = null;
  interactTarget: Pickup | null = null;
  roomActive = false;
  bot: Bot | null = null;
  /** Set while playing an online 1v1 instead of a roguelike run. */
  versus: Versus | null = null;
  speed = 1;
  introT = 0;
  touch: TouchState = { mx: 0, my: 0, aimAng: 0, aiming: false, fire: false };
  /** Aim direction in touch mode after aim assist; persists when the stick is released. */
  touchAim = 0;

  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private wheel = 0;
  /** Presses latched from input events, so a tap shorter than one frame is never lost. */
  private pressed = new Set<string>();
  /** After a menu closes, ignore the mouse button until it is released (the click that closed it is not a shot). */
  private fireLock = false;
  private waves: EnemyType[][] = [];
  private waveIdx = 0;
  private activateT = -1;
  private waveGap = 0;
  private transition: Transition | null = null;
  private fade!: Phaser.GameObjects.Rectangle;
  private timers: Timer[] = [];
  private booms: { x: number; y: number; t: number }[] = [];
  private camX = 0;
  private camY = 0;
  private focus: { x: number; y: number } | null = null;
  private shakeOut = { x: 0, y: 0, rot: 0 };
  private startData: StartData = {};
  private rng = new RNG(1);
  private lastStand = false;

  constructor() {
    super('Game');
  }

  init(data: StartData): void {
    this.startData = data ?? {};
  }

  get bulletSpeedMul(): number {
    return 1 + 0.06 * this.run.floorIndex + 0.12 * this.run.loop;
  }

  get comboMult(): number {
    return 1 + Math.min(this.run.combo, 30) * 0.1;
  }

  // ------------------------------------------------------------ setup

  create(): void {
    const d = this.startData;
    this.room = undefined as unknown as Room;
    this.bot = null;
    this.versus = null;
    this.lastStand = false;
    this.paused = false;
    this.modal = false;
    this.transition = null;
    this.timers = [];
    this.booms = [];
    this.bossEnemy = null;
    this.focus = null;
    this.introT = 0;
    this.speed = d.speed ?? 1;
    this.touch = { mx: 0, my: 0, aimAng: 0, aiming: false, fire: false };
    this.touchAim = -Math.PI / 2;

    const kb = this.input.keyboard!;
    this.keys = kb.addKeys({
      w: 'W', a: 'A', s: 'S', d: 'D', up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT',
      space: 'SPACE', shift: 'SHIFT', r: 'R', e: 'E', q: 'Q', f: 'F',
      one: 'ONE', two: 'TWO', three: 'THREE', four: 'FOUR', esc: 'ESC', p: 'P',
    }) as Record<string, Phaser.Input.Keyboard.Key>;
    this.input.mouse?.disableContextMenu();
    this.pressed.clear();
    this.wheel = 0;
    for (const [name, key] of Object.entries(this.keys)) {
      key.off('down');
      key.on('down', () => this.pressed.add(name));
    }
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (ptr.button === 0) this.pressed.add('lmb');
      if (ptr.button === 2) this.pressed.add('rmb');
    });
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      this.wheel += Math.sign(dy);
    });
    this.input.setDefaultCursor('none');

    this.fx = new Fx(this);
    this.bullets = new Bullets(this);
    this.enemies = new Enemies(this);
    this.pickups = new Pickups(this);
    this.player = new Player(this);
    this.player.god = d.god ?? false;
    this.fade = this.add.rectangle(GW / 2, GH / 2, GW + 200, GH + 200, 0x050405, 1).setScrollFactor(0).setDepth(100);

    const seed = d.versus?.seed ?? d.seed ?? Math.floor(Math.random() * 0x7fffffff);
    this.rng = new RNG(seed);
    this.run = {
      seed, floorIndex: 0, loop: 0, plan: null as unknown as FloorPlan, roomId: 0, coins: 0, coinsEarned: 0, score: 0, kills: 0,
      combo: 0, comboT: 0, comboMax: 3.2, bestCombo: 0, time: 0, upgrades: {}, stats: computeStats({}),
      damageDealt: 0, damageTaken: 0, roomsCleared: 0, shots: 0, rolls: 0, perfects: 0, bossesKilled: 0, over: false, won: false,
    };
    if (d.versus) this.versus = new Versus(this, d.versus);
    this.player.hp = this.player.maxHp;
    for (const id of d.weapons ?? []) {
      if (WEAPONS[id]) this.player.giveWeapon(makeWeapon(id));
    }

    this.scene.launch('UI');
    this.startFloor(d.floor ?? 0, 0, true);
    if (this.versus) {
      this.versus.begin();
      this.scene.launch('VsHud');
    }

    if (d.room) {
      const target = this.run.plan.rooms.find((r) => r.type === d.room);
      if (target) this.enterRoom(target.id, null);
    }
    if (d.bot) {
      this.bot = new Bot(this);
      audio.unlock();
    }

    audio.startMusic();
    this.game.events.on('blur', this.onBlur, this);
    // phone locked or app switched
    this.game.events.on(Phaser.Core.Events.HIDDEN, this.onBlur, this);
    this.events.once('shutdown', () => {
      this.versus?.dispose();
      this.game.events.off('blur', this.onBlur, this);
      this.game.events.off(Phaser.Core.Events.HIDDEN, this.onBlur, this);
      this.input.off('wheel');
      this.input.off('pointerdown');
      for (const key of Object.values(this.keys)) key.off('down');
    });
    (window as unknown as { __golibaaz: unknown }).__golibaaz = this;
    if (!this.versus) writeSave({ runs: loadSave().runs + 1 });
  }

  private onBlur(): void {
    if (!this.run.over && !this.modal && !this.bot && !this.versus) this.events.emit('pause', true);
  }

  /** Target camera zoom for the current input mode; touch pulls back for boss fights. */
  get zoom(): number {
    // versus: pull back so the whole arena (and the other player) stays on screen
    if (this.versus) return isTouch() ? 1.15 : 1;
    if (!isTouch()) return ZOOM;
    return this.bossEnemy ? TOUCH_BOSS_ZOOM : TOUCH_ZOOM;
  }

  /** An on-screen touch button was pressed: latched like a key press, so a quick tap is never lost. */
  touchPress(a: TouchAction): void {
    if (a === 'cycle') this.wheel += 1;
    else this.pressed.add(TOUCH_KEYS[a]);
  }

  /** Run a callback after a delay measured in real (unscaled) seconds. */
  after(sec: number, fn: () => void): void {
    this.timers.push({ t: sec, fn });
  }

  // ------------------------------------------------------------ floors and rooms

  private startFloor(index: number, loop: number, first = false): void {
    const run = this.run;
    run.floorIndex = index;
    run.loop = loop;
    run.plan = this.versus ? arenaPlan(run.seed) : generateFloor(this.rng.seed(), index, loop);
    this.theme = THEMES[index % THEMES.length];
    this.fx.darkColor = this.theme.dark;
    this.fx.darkAlpha = this.theme.darkAlpha;
    this.cameras.main.setBackgroundColor(this.theme.bg);
    audio.setFloor(index + loop);

    const p = this.player;
    if (!first) p.heal(2);
    p.blanks = Math.max(p.blanks, run.stats.blanksPerFloor);
    if (!first) p.armor += run.stats.armorPerFloor;

    this.enterRoom(run.plan.startId, null);
    if (!first) this.events.emit('floor', this.theme, index + loop * 3 + 1);
  }

  private enterRoom(id: number, via: Dir | null): void {
    const run = this.run;
    if (this.room) {
      this.room.node.saved = this.pickups.save();
      this.pickups.clear();
      this.enemies.clear();
      this.bullets.clearAll();
      this.fx.clearTransient();
      this.room.destroy();
    }
    const node = run.plan.rooms[id];
    run.roomId = id;
    this.room = new Room(this, node, this.theme, run.floorIndex);
    const firstVisit = !node.visited;
    node.visited = true;
    node.seen = true;
    for (const d of DIRS) {
      const n = node.doors[d];
      if (n !== undefined) run.plan.rooms[n].seen = true;
    }

    if (via) {
      const e = this.room.entry(OPP[via]);
      this.player.setPos(e.x, e.y);
    } else {
      const oy = node.type === 'start' ? 0 : node.type === 'boss' ? this.room.ph / 2 - TILE * 2.5 : TILE * 2;
      this.player.setPos(this.room.pw / 2, this.room.ph / 2 + oy);
    }

    if (firstVisit) this.populate(node);
    else this.pickups.restore(node.saved ?? []);
    node.saved = undefined;

    this.room.updateFlow(this.player.x, this.player.y);
    this.roomActive = false;
    this.bossEnemy = null;
    this.activateT = -1;
    this.interactTarget = null;

    if (node.type === 'combat' && !node.cleared) {
      this.waves = generateWaves(node.seed, run.floorIndex, node.depth, run.loop);
      this.waveIdx = -1;
      this.activateT = 0.3;
    } else if (node.type === 'boss' && !node.cleared) {
      this.startBoss();
    } else {
      audio.setIntensity(0);
    }

    this.snapCamera();
    this.events.emit('room', node);
  }

  private pickWeapon(exclude: string[] = []): string {
    const owned = new Set(this.player.weapons.map((w) => w.def.id));
    const maxTier = Math.min(3, this.run.floorIndex + 1 + this.run.loop * 3);
    let pool = WEAPON_IDS.filter((id) => id !== 'pistol' && !owned.has(id) && !exclude.includes(id) && WEAPONS[id].tier <= maxTier);
    if (!pool.length) pool = WEAPON_IDS.filter((id) => id !== 'pistol' && !owned.has(id) && !exclude.includes(id));
    if (!pool.length) pool = WEAPON_IDS.filter((id) => id !== 'pistol');
    // favour the best tier available on this floor
    const weighted: string[] = [];
    for (const id of pool) {
      const n = WEAPONS[id].tier === maxTier ? 3 : 1;
      for (let i = 0; i < n; i++) weighted.push(id);
    }
    return weighted[Math.floor(Math.random() * weighted.length)];
  }

  private populate(node: RoomNode): void {
    const cx = this.room.pw / 2;
    const cy = this.room.ph / 2;
    const run = this.run;
    const priceMul = 1 + 0.45 * run.floorIndex + 0.9 * run.loop;
    const price = (n: number) => Math.round((n * priceMul) / 5) * 5;

    if (node.type === 'treasure') {
      this.pickups.spawn('chest', cx, cy - TILE * 1.2, { weapon: this.pickWeapon() });
      const ups = rollUpgrades(run.upgrades, 2, Math.random);
      ups.forEach((u, i) => {
        this.pickups.spawn('upgrade', cx + (i === 0 ? -TILE * 2 : TILE * 2), cy + TILE * 1.3, { upgrade: u.id, group: node.id });
      });
    } else if (node.type === 'shop') {
      const ups = rollUpgrades(run.upgrades, 2, Math.random);
      const weapon = this.pickWeapon();
      const stock: { item: NonNullable<Pickup['data']['item']>; weapon?: string; upgrade?: string; price: number }[] = [
        { item: 'heart', price: price(20) },
        { item: 'ammo', price: price(15) },
      ];
      for (const u of ups) stock.push({ item: 'upgrade', upgrade: u.id, price: price(55) });
      stock.push({ item: 'weapon', weapon, price: price(WEAPONS[weapon].price) });
      stock.push(Math.random() < 0.5 ? { item: 'blank', price: price(20) } : { item: 'armor', price: price(25) });
      const gap = 150;
      const x0 = cx - ((stock.length - 1) * gap) / 2;
      stock.forEach((st, i) => {
        this.pickups.spawn('shop', x0 + i * gap, cy - 10, { item: st.item, weapon: st.weapon, upgrade: st.upgrade, price: st.price });
      });
    }
  }

  private startBoss(): void {
    const def = BOSSES[this.run.floorIndex % BOSSES.length];
    this.room.setLocked(true, false);
    this.bossEnemy = this.enemies.spawnBoss(def, this.room.pw / 2, this.room.ph / 2);
    this.roomActive = true;
    this.introT = 2.1;
    this.player.frozen = true;
    this.focus = { x: this.bossEnemy.x, y: this.bossEnemy.y };
    audio.play('bossIntro');
    audio.play('doorClose');
    audio.setIntensity(2);
    this.events.emit('bossIntro', def);
  }

  private nextWave(): void {
    this.waveIdx++;
    if (this.waveIdx >= this.waves.length) {
      this.clearRoom();
      return;
    }
    this.enemies.spawnWave(this.waves[this.waveIdx]);
  }

  private clearRoom(): void {
    const node = this.room.node;
    node.cleared = true;
    this.roomActive = false;
    this.room.setLocked(false);
    this.bullets.clearEnemy();
    this.pickups.vacuum = true;
    this.run.roomsCleared++;
    this.run.score += 100 * (1 + this.run.loop);
    audio.play('doorOpen');
    audio.play('clear');
    audio.setIntensity(0);
    this.events.emit('cleared');

    // a small reward now and then
    const p = this.player;
    const cx = this.room.pw / 2;
    const cy = this.room.ph / 2;
    const spot = this.room.solidAt(cx, cy) ? this.room.randomFree(cx, cy, 0, 2) : { x: cx, y: cy };
    const roll = Math.random();
    const lowHp = p.hp <= 2;
    if (roll < (lowHp ? 0.5 : 0.16)) this.pickups.spawn('half', spot.x, spot.y, {}, 60);
    else if (roll < 0.36 && p.needsAmmo()) this.pickups.spawn('ammo', spot.x, spot.y, {}, 60);
    else if (roll < 0.42) this.pickups.spawn('blank', spot.x, spot.y, {}, 60);
    else if (roll < 0.6) this.pickups.dropCoins(spot.x, spot.y, rndInt(4, 8));
  }

  private goThrough(dir: Dir): void {
    const next = this.room.node.doors[dir];
    if (next === undefined || this.transition) return;
    this.player.frozen = true;
    this.transition = {
      t: 0, phase: 0,
      mid: () => {
        this.enterRoom(next, dir);
        if (this.introT <= 0) this.player.frozen = false;
      },
    };
  }

  /** Take the stairs to the next floor. */
  descend(): void {
    if (this.transition) return;
    const run = this.run;
    audio.play('stairs');
    this.player.frozen = true;
    this.transition = {
      t: 0, phase: 0,
      mid: () => {
        if (this.room) {
          this.pickups.clear();
          this.enemies.clear();
          this.bullets.clearAll();
          this.fx.clearTransient();
          this.room.destroy();
          this.room = undefined as unknown as Room;
        }
        if (run.floorIndex >= 2) this.startFloor(0, run.loop + 1);
        else this.startFloor(run.floorIndex + 1, run.loop);
        this.player.frozen = false;
      },
    };
  }

  // ------------------------------------------------------------ combat events

  addUpgrade(id: string): void {
    const run = this.run;
    const def = UPGRADE_MAP[id];
    if (!def) return;
    run.upgrades[id] = (run.upgrades[id] ?? 0) + 1;
    run.stats = computeStats(run.upgrades);
    run.comboMax = run.stats.comboKing ? 4.8 : 3.2;
    const p = this.player;
    if (id === 'heart') p.hp = p.maxHp;
    if (id === 'reserve') p.blanks++;
    if (id === 'coat') p.armor++;
    audio.play('upgrade');
    this.fx.ring(p.x, p.y, 30, 200, 0.5, 0xffe2a8, 0.9);
    this.fx.text(p.x, p.y - 56, def.name.toUpperCase(), '#ffe2a8', 30, 1.3);
    this.events.emit('upgrade', def);
  }

  breakCombo(): void {
    this.run.combo = 0;
    this.run.comboT = 0;
  }

  useBlank(): void {
    const p = this.player;
    if (p.blanks <= 0 || p.dead || p.frozen) return;
    p.blanks--;
    this.bullets.clearEnemy();
    this.enemies.shove(p.x, p.y, 560, 950, 0.9);
    this.fx.ring(p.x, p.y, 40, 900, 0.5, 0xcfeaf5, 0.9);
    this.fx.ring(p.x, p.y, 20, 520, 0.35, 0xffffff, 0.8, 'ringThin');
    this.fx.flash(p.x, p.y, 1400, 0.4);
    this.fx.shake(0.5);
    this.cameras.main.flash(160, 220, 240, 255);
    audio.play('blank');
    p.invuln = Math.max(p.invuln, 0.6);
  }

  explode(x: number, y: number, radius: number, o: { enemyDmg: number; hurtPlayer: boolean }): void {
    this.fx.explosion(x, y, radius);
    if (o.enemyDmg > 0) {
      for (const e of [...this.enemies.list]) {
        const d = Math.hypot(e.x - x, e.y - y);
        if (d > radius + e.r) continue;
        this.enemies.damage(e, o.enemyDmg, Math.atan2(e.y - y, e.x - x), 420, false);
      }
    }
    for (const prop of [...this.room.props]) {
      if (Math.hypot(prop.x - x, prop.y - y) < radius + 20) this.damageProp(prop, 60, Math.atan2(prop.y - y, prop.x - x));
    }
    const p = this.player;
    if (o.hurtPlayer && Math.hypot(p.x - x, p.y - y) < radius * 0.88) p.hurt(Math.atan2(p.y - y, p.x - x));
  }

  damageProp(prop: Prop, dmg: number, ang: number): void {
    if (prop.dead) return;
    prop.hp -= dmg;
    prop.shakeT = 0.12;
    if (prop.hp > 0) {
      if (prop.kind === 'crate') this.fx.debris(prop.x, prop.y, ang + Math.PI, 1, 0xffffff, 'plank', 200, 1);
      return;
    }
    const { x, y, kind } = prop;
    this.room.removeProp(prop);
    if (kind === 'crate') {
      this.fx.debris(x, y, ang, 9, 0xffffff, 'plank', 380, 1.6);
      this.fx.dust(x, y, 8, 0xa58a60, 160, 0.8);
      this.fx.shake(0.1);
      audio.play('crate');
      if (Math.random() < 0.3) this.pickups.dropCoins(x, y, rndInt(1, 3));
      else if (Math.random() < 0.05 && this.player.needsAmmo()) this.pickups.spawn('ammo', x, y);
    } else {
      // barrels go off a beat later so chains ripple across the room
      this.booms.push({ x, y, t: 0.07 });
    }
  }

  onEnemyKilled(e: Enemy, ang: number): void {
    const run = this.run;
    const p = this.player;
    const stats = run.stats;

    if (e.boss) {
      this.onBossKilled(e);
      return;
    }

    run.kills++;
    run.combo++;
    run.comboT = run.comboMax;
    run.bestCombo = Math.max(run.bestCombo, run.combo);
    if (run.combo > 0 && run.combo % 5 === 0) audio.play('combo');
    run.score += Math.round(e.def.score * this.comboMult * (e.elite ? 2 : 1) * (1 + run.loop));

    // loot
    let coins = rndInt(e.def.coins[0], e.def.coins[1]) + Math.min(2, Math.floor(run.combo / 6));
    if (e.elite) coins = coins * 2 + 2;
    coins *= stats.coin;
    const whole = Math.floor(coins) + (Math.random() < coins % 1 ? 1 : 0);
    this.pickups.dropCoins(e.x, e.y, whole);
    const heartChance = p.hp <= 2 ? 0.07 : 0.022;
    if (Math.random() < heartChance) this.pickups.spawn('half', e.x, e.y, {}, 120);
    else if (Math.random() < 0.045 * stats.ammoDrop && p.needsAmmo()) this.pickups.spawn('ammo', e.x, e.y, {}, 120);

    if (stats.vamp > 0) {
      p.killsSinceHeal++;
      if (p.killsSinceHeal >= stats.vamp) {
        p.killsSinceHeal = 0;
        if (p.heal(1)) {
          this.fx.text(p.x, p.y - 44, 'BLOOD DEBT', '#ff8a7a', 22, 0.8);
          audio.play('heart', 0.6);
        }
      }
    }
    if (stats.shrapnel > 0 && Math.random() < stats.shrapnel) {
      const off = rnd(0, TAU);
      for (let i = 0; i < 8; i++) {
        const b = this.bullets.firePlayer('pbPellet', e.x, e.y, off + (i / 8) * TAU, 900, 4.5, 12 * stats.dmg, 0.35);
        if (b) b.hitIds.push(e.id);
      }
      this.fx.ring(e.x, e.y, 10, 90, 0.2, 0xffe2a8, 0.7, 'ringThin');
    }

    // slow motion on the kill that empties the room
    if (this.roomActive && !this.bossEnemy && this.enemies.aliveCount === 0 && this.waveIdx >= this.waves.length - 1) {
      this.fx.slowmo(0.22, 0.55);
      this.fx.shake(0.3);
    }
    void ang;
  }

  private onBossKilled(e: Enemy): void {
    const run = this.run;
    const node = this.room.node;
    node.cleared = true;
    this.roomActive = false;
    run.bossesKilled++;
    run.score += 1500 * (1 + run.loop);
    this.bullets.clearEnemy();
    for (const o of [...this.enemies.list]) this.enemies.kill(o);
    for (const sp of this.enemies.pending) sp.mark.destroy();
    this.enemies.pending = [];
    this.fx.slowmo(0.25, 1.7);
    this.fx.hitstop(0.14);
    audio.play('bossDeath');
    audio.setIntensity(0);
    this.focus = { x: e.x, y: e.y };
    this.events.emit('bossDead');
    e.glint.destroy();
    e.aux?.destroy();
    e.img.setTintFill(0xffffff);

    for (let i = 0; i < 8; i++) {
      this.after(0.12 + i * 0.17, () => {
        const a = rnd(0, TAU);
        const d = rnd(0, e.r);
        this.fx.explosion(e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, rnd(70, 120));
        if (e.img.active) {
          e.img.setPosition(e.x + rnd(-6, 6), e.y + rnd(-6, 6));
          if (i % 2 === 0) e.img.clearTint();
          else e.img.setTintFill(0xffffff);
        }
      });
    }
    this.after(1.6, () => {
      this.fx.explosion(e.x, e.y, 260);
      this.fx.ring(e.x, e.y, 60, 1100, 0.7, 0xffe2a8, 0.9);
      this.cameras.main.flash(380, 255, 240, 210);
      this.fx.debris(e.x, e.y, 0, 22, e.def.tint, 'chunk', 620, Math.PI);
      e.img.destroy();
      e.shadow.destroy();
      this.pickups.dropCoins(e.x, e.y, Math.round(rndInt(32, 42) * run.stats.coin));
      this.pickups.spawn('heart', e.x, e.y, {}, 160);
      this.pickups.vacuum = true;
      this.focus = null;
      this.bossEnemy = null;
    });
    this.after(3.0, () => {
      this.room.setLocked(false);
      audio.play('doorOpen');
      if (run.floorIndex >= 2) {
        run.won = true;
        writeSave({ wins: loadSave().wins + (run.loop === 0 ? 1 : 0) });
        this.saveBest();
        this.modal = true;
        this.events.emit('victory');
      } else {
        this.offerBossReward();
      }
    });
  }

  /** After a boss: stairs appear and the player picks one of three upgrades. */
  offerBossReward(): void {
    const cx = this.room.pw / 2;
    const cy = this.room.ph / 2;
    this.pickups.spawn('stairs', cx, cy);
    this.fx.ring(cx, cy, 30, 220, 0.5, 0xffe2a8, 0.8);
    const options = rollUpgrades(this.run.upgrades, 3, Math.random);
    if (options.length) {
      this.modal = true;
      this.events.emit('upgradeChoice', options);
    }
  }

  chooseUpgrade(def: UpgradeDef): void {
    this.modal = false;
    this.addUpgrade(def.id);
  }

  /** From the victory screen: keep going into a harder loop. */
  continueAfterVictory(): void {
    this.modal = false;
    this.run.won = false;
    this.offerBossReward();
  }

  private saveBest(): void {
    const s = loadSave();
    const depth = this.run.loop * 3 + this.run.floorIndex + 1;
    writeSave({ bestScore: Math.max(s.bestScore, this.run.score), bestFloor: Math.max(s.bestFloor, depth) });
  }

  onPlayerDied(): void {
    const p = this.player;
    if (this.versus) {
      // a lost round, not the end of a run: the versus layer decides what happens next
      this.fx.blood(p.x, p.y, 0, 4);
      this.fx.debris(p.x, p.y, 0, 12, 0x30495a, 'chunk', 460, Math.PI);
      this.fx.ring(p.x, p.y, 30, 500, 0.6, 0xffffff, 0.8);
      this.fx.shake(0.8);
      audio.play('death');
      this.versus.onMyDeath();
      return;
    }
    this.run.over = true;
    this.fx.slowmo(0.15, 1.6);
    this.fx.blood(p.x, p.y, 0, 4);
    this.fx.debris(p.x, p.y, 0, 12, 0x30495a, 'chunk', 460, Math.PI);
    this.fx.ring(p.x, p.y, 30, 500, 0.6, 0xffffff, 0.8);
    this.fx.shake(1);
    audio.play('death');
    audio.setIntensity(0);
    const prevBest = loadSave().bestScore;
    this.saveBest();
    this.after(1.7, () => {
      this.modal = true;
      this.events.emit('gameOver', this.run.score > prevBest && prevBest > 0);
    });
  }

  // ------------------------------------------------------------ input

  /** True once per press, however brief. */
  private take(name: string): boolean {
    return this.pressed.delete(name);
  }

  private readInput(): void {
    const c = this.ctrl;
    const k = this.keys;
    const ptr = this.input.activePointer;
    c.mx = (k.d.isDown || k.right.isDown ? 1 : 0) - (k.a.isDown || k.left.isDown ? 1 : 0);
    c.my = (k.s.isDown || k.down.isDown ? 1 : 0) - (k.w.isDown || k.up.isDown ? 1 : 0);
    if (isTouch()) {
      // twin-stick: UIScene writes this.touch; pointer buttons mean nothing here
      const t = this.touch;
      if (t.mx !== 0 || t.my !== 0) {
        c.mx = t.mx;
        c.my = t.my;
      }
      this.take('lmb');
      if (t.aiming) this.touchAim = this.assistAim(t.aimAng);
      const p = this.player;
      c.aimX = p.x + Math.cos(this.touchAim) * TOUCH_AIM_LEAD;
      c.aimY = p.y + Math.sin(this.touchAim) * TOUCH_AIM_LEAD;
      c.fire = t.fire;
      if (this.fireLock) {
        if (!t.fire) this.fireLock = false;
        c.fire = false;
      }
    } else {
      const wp = this.cameras.main.getWorldPoint(ptr.x, ptr.y);
      c.aimX = wp.x;
      c.aimY = wp.y;
      const tapped = this.take('lmb');
      c.fire = ptr.leftButtonDown() || tapped;
      if (this.fireLock) {
        if (!ptr.leftButtonDown()) this.fireLock = false;
        c.fire = false;
      }
    }
    const space = this.take('space');
    const shift = this.take('shift');
    const rmb = this.take('rmb');
    c.roll = space || shift || rmb;
    c.reload = this.take('r');
    c.interact = this.take('e');
    const q = this.take('q');
    const f = this.take('f');
    c.blank = q || f;
    c.slot = this.take('one') ? 0 : this.take('two') ? 1 : this.take('three') ? 2 : this.take('four') ? 3 : -1;
    c.cycle = this.wheel > 0 ? 1 : this.wheel < 0 ? -1 : 0;
    this.wheel = 0;
    this.pressed.clear();
  }

  /** Light aim assist: nudge the stick direction toward a visible enemy inside a narrow cone. */
  private assistAim(a: number): number {
    const p = this.player;
    let best = 0;
    let bestScore = Infinity;
    for (const e of this.enemies.list) {
      if (e.dead || e.spawnT > 0 || !e.hasLos) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > AIM_ASSIST_RANGE || d < 1) continue;
      const da = angDiff(a, Math.atan2(dy, dx));
      // allow a little extra cone for big targets up close
      const cone = AIM_ASSIST_CONE + Math.atan2(e.r, d) * 0.5;
      if (Math.abs(da) > cone) continue;
      const score = Math.abs(da) / cone + d / AIM_ASSIST_RANGE * 0.5;
      if (score < bestScore) {
        bestScore = score;
        best = da;
      }
    }
    return a + best * AIM_ASSIST_STRENGTH;
  }

  private clearEdges(): void {
    const c = this.ctrl;
    c.roll = c.reload = c.interact = c.blank = false;
    c.slot = -1;
    c.cycle = 0;
  }

  // ------------------------------------------------------------ frame

  update(time: number, delta: number): void {
    const esc = this.take('esc');
    const pKey = this.take('p');
    if (this.versus) {
      // no pausing a live match: Esc leaves it
      if (esc) this.versus.leave();
    } else if (esc || pKey) {
      if (!this.run.over && !this.modal) this.events.emit('pause', !this.paused);
    }
    if (this.paused || this.modal) {
      // don't let presses made on a menu leak into the game when it closes
      this.pressed.clear();
      this.wheel = 0;
      this.fireLock = true;
    }
    if (this.paused) return;

    const dtReal = Math.min(delta, 50) / 1000;
    if (this.bot) this.bot.update(this.ctrl);
    else this.readInput();

    for (let i = 0; i < this.speed; i++) {
      this.step(dtReal, time);
      this.clearEdges();
    }
    this.present(dtReal, time);
  }

  private step(dtReal: number, time: number): void {
    const run = this.run;
    const p = this.player;

    // real-time timers
    if (this.timers.length) {
      const due: Timer[] = [];
      for (const t of this.timers) {
        t.t -= dtReal;
        if (t.t <= 0) due.push(t);
      }
      if (due.length) {
        this.timers = this.timers.filter((t) => t.t > 0);
        for (const t of due) t.fn();
      }
    }

    // room transition fade
    if (this.transition) {
      const tr = this.transition;
      tr.t += dtReal;
      if (tr.phase === 0) {
        this.fade.setAlpha(clamp(tr.t / 0.13, 0, 1));
        if (tr.t >= 0.13) {
          tr.phase = 1;
          tr.t = 0;
          tr.mid();
        }
      } else {
        this.fade.setAlpha(1 - clamp(tr.t / 0.22, 0, 1));
        if (tr.t >= 0.22) this.transition = null;
      }
    } else if (this.fade.alpha > 0) {
      this.fade.setAlpha(Math.max(0, this.fade.alpha - dtReal * 2.5));
    }
    if (!this.room) return;
    this.versus?.update(dtReal);

    let dt = this.fx.timeScale(dtReal);
    if (this.modal) dt = 0;

    // boss intro: hold everything while the camera shows who you're fighting
    if (this.introT > 0) {
      this.introT -= dtReal;
      dt = 0;
      if (this.introT <= 0) {
        p.frozen = false;
        this.focus = null;
      }
    }

    if (dt > 0) {
      run.time += dt;
      if (run.combo > 0) {
        run.comboT -= dt;
        if (run.comboT <= 0) this.breakCombo();
      }

      // room activation
      if (this.activateT > 0) {
        this.activateT -= dt;
        if (this.activateT <= 0) {
          this.room.setLocked(true);
          this.roomActive = true;
          audio.play('doorClose');
          audio.setIntensity(1);
          this.fx.shake(0.12);
          this.nextWave();
        }
      }

      p.update(dt, this.ctrl, time);
      if (this.ctrl.blank) this.useBlank();
      this.room.updateFlow(p.x, p.y);
      this.enemies.update(dt, time);
      this.bullets.update(dt);
      this.pickups.update(dt, time);
      this.room.update(dt, time);

      for (const b of this.booms) {
        b.t -= dt;
        if (b.t <= 0) this.explode(b.x, b.y, 140, { enemyDmg: 70, hurtPlayer: true });
      }
      if (this.booms.length) this.booms = this.booms.filter((b) => b.t > 0);

      // waves
      if (this.roomActive && !this.bossEnemy && this.room.node.type === 'combat' && this.enemies.aliveCount === 0) {
        this.waveGap += dt;
        if (this.waveGap > 0.45) {
          this.waveGap = 0;
          this.nextWave();
        }
      } else {
        this.waveGap = 0;
      }

      // interaction
      this.interactTarget = p.dead || this.roomActive ? null : this.pickups.nearest();
      if (this.interactTarget && this.ctrl.interact) {
        this.pickups.interact(this.interactTarget);
        this.interactTarget = null;
      }

      // doors
      if (!this.transition && !this.roomActive && !p.dead && this.room) {
        const dir = this.room.doorAt(p.x, p.y);
        if (dir) this.goThrough(dir);
      }

      // last-heart warning
      const low = p.hp <= 1 && !p.dead;
      if (low !== this.lastStand) {
        this.lastStand = low;
        this.events.emit('lowHp', low);
      }
    }

    // while a menu is up the world holds still, but effects already in the air finish playing
    this.fx.update(dtReal, this.modal ? dtReal * 0.6 : dt);
  }

  /** Re-centre the camera instantly (versus: after a round reset moves the player). */
  snapCameraNow(): void {
    this.snapCamera();
  }

  private snapCamera(): void {
    // snap to the mode's base zoom; present() then eases into a boss fight's wider view
    this.cameras.main.setZoom(isTouch() ? TOUCH_ZOOM : ZOOM);
    const t = this.cameraTarget();
    this.camX = t.x;
    this.camY = t.y;
    this.cameras.main.setScroll(this.camX - GW / 2, this.camY - GH / 2);
  }

  private cameraTarget(): { x: number; y: number } {
    const p = this.player;
    const room = this.room;
    let tx = p.x;
    let ty = p.y;
    if (this.focus) {
      tx = this.focus.x;
      ty = this.focus.y;
    } else if (!p.dead) {
      // lean toward where the player is aiming
      let ax = (this.ctrl.aimX - p.x) * 0.17;
      let ay = (this.ctrl.aimY - p.y) * 0.17;
      const l = Math.hypot(ax, ay);
      if (l > 130) {
        ax = (ax / l) * 130;
        ay = (ay / l) * 130;
      }
      tx += ax;
      ty += ay;
    }
    // returns the world point the camera should centre on
    const margin = 70;
    const axis = (t: number, size: number, view: number) => {
      if (size + margin * 2 <= view) return size / 2 + clamp((t - size / 2) * 0.12, -40, 40);
      return clamp(t, view / 2 - margin, size - view / 2 + margin);
    };
    // clamp against the zoom on screen right now, so the view stays inside the room while it eases
    const zoom = this.cameras.main.zoom;
    return { x: axis(tx, room.pw, GW / zoom), y: axis(ty, room.ph, GH / zoom) };
  }

  /** Camera, lights and other per-rendered-frame work. */
  private present(dtReal: number, time: number): void {
    if (!this.room) return;
    const cam = this.cameras.main;
    const zt = this.zoom;
    if (cam.zoom !== zt) cam.setZoom(Math.abs(cam.zoom - zt) < 0.002 ? zt : damp(cam.zoom, zt, ZOOM_EASE, dtReal));
    const t = this.cameraTarget();
    const rate = this.focus ? 3.5 : 9;
    this.camX = damp(this.camX, t.x, rate, dtReal);
    this.camY = damp(this.camY, t.y, rate, dtReal);
    this.fx.shakeOffset(time, this.shakeOut);
    cam.setScroll(this.camX - GW / 2 + this.shakeOut.x, this.camY - GH / 2 + this.shakeOut.y);
    cam.setRotation(this.shakeOut.rot);

    const fx = this.fx;
    const p = this.player;
    fx.beginLights();
    if (!p.dead) fx.light(p.x, p.y, 640, 1);
    if (this.versus?.remote.alive) fx.light(this.versus.remote.x, this.versus.remote.y, 520, 0.9);
    for (const l of this.room.lamps) fx.light(l.x, l.y, 380, 0.85);
    for (const e of this.enemies.list) {
      if (e.boss) fx.light(e.x, e.y, 560, 0.9);
      else if (e.elite) fx.light(e.x, e.y, 200, 0.5);
    }
    if (this.bossEnemy && this.bossEnemy.dead && this.bossEnemy.img.active) fx.light(this.bossEnemy.x, this.bossEnemy.y, 600, 1);
    for (const pk of this.pickups.list) {
      if (pk.kind === 'chest' || pk.kind === 'upgrade' || pk.kind === 'shop' || pk.kind === 'stairs' || pk.kind === 'weapon') {
        fx.light(pk.x, pk.y, 260, 0.7);
      }
    }
    fx.endLights();
  }
}
