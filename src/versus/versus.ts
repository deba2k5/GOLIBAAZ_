/**
 * Online 1v1 for GOLIBAAZ.
 *
 * Every machine simulates its own player and nobody else's. What goes over the wire:
 *   st   my position, aim, weapon, hp, rolling (20 times a second)
 *   sh   a shot I fired: the bullets, their speed and how much each one hurts
 *   dead I just died
 * A shot from the other player is replayed here as an enemy bullet, so the existing bullet code
 * decides whether it hits ME. Damage is therefore always applied on the machine of the player who
 * was hit, which keeps both screens honest without a server simulating anything.
 */
import Phaser from 'phaser';
import { DEPTH } from '../config';
import { audio } from '../core/audio';
import { damp } from '../core/math';
import { type Net, type NetMsg } from '../core/net';
import { computeStats } from '../entities/upgrades';
import { WEAPONS, makeWeapon } from '../entities/weapons';
import { avatarTint } from './avatars';
import { WEAPON_GRIP_X, WEAPON_TEX_W } from '../gfx/textures';
import type { GameScene } from '../scenes/GameScene';
import type { FloorPlan, RoomNode } from '../world/floorgen';

export interface VersusInit {
  net: Net;
  slot: 0 | 1;
  seed: number;
  /** Each player's bet in USDC base units, as a string. '0' = free play. */
  stake?: string;
  avatar?: number;
  oppAvatar?: number;
}

/** Everyone starts every round with the same four guns, picked to be fair (no explosives, no one-shots). */
export const LOADOUT = ['pistol', 'rifle', 'shotgun', 'revolver'];
export const WIN_SCORE = 3;
const HEARTS = 5;
const STATE_HZ = 20;
const COUNTDOWN = 2.6;
const BETWEEN = 2.4;

export type Phase = 'countdown' | 'fight' | 'between' | 'over' | 'left';

/** The other player: a puppet that follows the positions it is sent. */
export class Remote {
  x = 0;
  y = 0;
  tx = 0;
  ty = 0;
  aim = 0;
  taim = 0;
  r = 17;
  hitR = 12;
  hp = HEARTS * 2;
  alive = true;
  rolling = false;
  reloading = false;
  weaponId = 'pistol';
  private flashT = 0;
  private rollSpin = 0;
  private kick = 0;
  shadow: Phaser.GameObjects.Image;
  body: Phaser.GameObjects.Image;
  gun: Phaser.GameObjects.Image;

  tint = 0xff9a86;

  constructor(scene: Phaser.Scene, tint = 0xff9a86) {
    this.tint = tint;
    this.shadow = scene.add.image(0, 0, 'shadow').setDepth(DEPTH.SHADOW).setScale(0.95);
    this.gun = scene.add.image(0, 0, 'w_pistol').setDepth(DEPTH.PLAYER).setOrigin(WEAPON_GRIP_X / WEAPON_TEX_W, 0.5);
    this.body = scene.add.image(0, 0, 'player').setDepth(DEPTH.PLAYER).setTint(tint);
  }

  setPos(x: number, y: number, aim: number): void {
    this.x = this.tx = x;
    this.y = this.ty = y;
    this.aim = this.taim = aim;
    this.sync();
  }

  flash(): void {
    this.flashT = 0.07;
  }

  recoil(): void {
    this.kick = 1;
  }

  setWeapon(id: string): void {
    if (id === this.weaponId || !WEAPONS[id]) return;
    this.weaponId = id;
    this.gun.setTexture(`w_${id}`);
  }

  setAlive(a: boolean): void {
    this.alive = a;
    this.body.setVisible(a);
    this.gun.setVisible(a);
    this.shadow.setVisible(a);
  }

  update(dt: number): void {
    this.x = damp(this.x, this.tx, 22, dt);
    this.y = damp(this.y, this.ty, 22, dt);
    let da = this.taim - this.aim;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    this.aim += da * Math.min(1, dt * 24);
    this.flashT = Math.max(0, this.flashT - dt);
    this.kick = damp(this.kick, 0, 16, dt);
    this.rollSpin = this.rolling ? this.rollSpin + dt * 15 : 0;
    this.sync();
  }

  private sync(): void {
    if (!this.alive) return;
    this.shadow.setPosition(this.x + 4, this.y + 6);
    this.body.setPosition(this.x, this.y);
    if (this.rolling) {
      this.body.rotation = this.rollSpin;
      this.body.setScale(0.85);
      this.gun.setVisible(false);
    } else {
      this.body.rotation = this.aim;
      this.body.setScale(1);
      let rot = this.aim;
      if (this.reloading) rot += 0.4;
      const back = this.kick * 9;
      this.gun.setVisible(true)
        .setPosition(this.x + Math.cos(this.aim) * (20 - back), this.y + Math.sin(this.aim) * (20 - back))
        .setRotation(rot);
    }
    if (this.flashT > 0) this.body.setTintFill(0xffffff);
    else this.body.setTint(this.tint);
  }

  destroy(): void {
    this.shadow.destroy();
    this.body.destroy();
    this.gun.destroy();
  }
}

/** The one-room arena both players fight in. Same seed on both machines, so the same layout. */
export function arenaPlan(seed: number): FloorPlan {
  const node: RoomNode = {
    id: 0, gx: 0, gy: 0, type: 'boss', doors: {}, depth: 0, cleared: true, visited: false, seen: false, seed,
  };
  return { rooms: [node], startId: 0, bossId: 0, index: 0, loop: 0, seed };
}

export class Versus {
  readonly net: Net;
  readonly slot: 0 | 1;
  readonly remote: Remote;
  phase: Phase = 'countdown';
  /** Seconds left in the current countdown / between-rounds pause. */
  timer = COUNTDOWN;
  score = { me: 0, opp: 0 };
  round = 1;
  /** Text the HUD shows in the middle of the screen. */
  banner = '';
  myAgain = false;
  oppAgain = false;
  /** Bet each player put up (USDC base units). 0n = free play. */
  readonly stake: bigint;
  readonly avatar: number;
  /** What the relay did with the money after the match, shown by the HUD. */
  settle: { outcome: string; amount: string } | null = null;
  private reported = false;
  private sendT = 0;
  private off: (() => void)[] = [];
  private lastCount = -1;
  private disposed = false;

  constructor(private scene: GameScene, init: VersusInit) {
    this.net = init.net;
    this.slot = init.slot;
    this.stake = BigInt(init.stake ?? '0');
    this.avatar = init.avatar ?? 0;
    this.remote = new Remote(scene, avatarTint(init.oppAvatar ?? 0));
    this.off.push(this.net.on((m) => this.onMsg(m)));
    this.off.push(this.net.onClose(() => this.onClosed()));
  }

  // ------------------------------------------------------------ setup

  /** Called once the arena room exists. */
  begin(): void {
    this.scene.run.stats = computeStats({});
    this.scene.run.stats.hearts = HEARTS;
    this.resetRound(true);
  }

  private spawn(slot: number): { x: number; y: number; aim: number } {
    const room = this.scene.room;
    const left = slot === 0;
    return { x: room.pw * (left ? 0.12 : 0.88), y: room.ph / 2, aim: left ? 0 : Math.PI };
  }

  private resetRound(first = false): void {
    const s = this.scene;
    const p = s.player;
    s.bullets.clearAll();
    s.fx.clearTransient();
    p.dead = false;
    p.body.setVisible(true);
    p.gun.setVisible(true);
    p.shadow.setVisible(true);
    p.hp = p.maxHp;
    p.armor = 0;
    p.blanks = 0;
    p.invuln = 0;
    p.rollT = 0;
    p.rollCd = 0;
    p.reloading = false;
    p.burstLeft = 0;
    p.weapons = LOADOUT.map((id) => makeWeapon(id));
    p.cur = 0;
    p.gun.setTexture('w_pistol');
    p.body.setTint(avatarTint(this.avatar));
    const me = this.spawn(this.slot);
    p.setPos(me.x, me.y);
    p.aim = me.aim;
    s.ctrl.aimX = me.x + Math.cos(me.aim) * 300;
    s.ctrl.aimY = me.y + Math.sin(me.aim) * 300;
    p.frozen = true;

    const other = this.spawn(this.slot === 0 ? 1 : 0);
    this.remote.setAlive(true);
    this.remote.hp = HEARTS * 2;
    this.remote.rolling = false;
    this.remote.setWeapon('pistol');
    this.remote.setPos(other.x, other.y, other.aim);

    this.phase = 'countdown';
    this.timer = first ? COUNTDOWN + 0.6 : COUNTDOWN;
    this.lastCount = -1;
    this.banner = `ROUND ${this.round}`;
    s.snapCameraNow();
  }

  // ------------------------------------------------------------ frame

  update(dt: number): void {
    const s = this.scene;
    const p = s.player;
    this.remote.update(dt);

    if (this.phase === 'countdown') {
      this.timer -= dt;
      const n = Math.ceil(this.timer);
      if (this.timer > 0) {
        if (n !== this.lastCount) {
          this.lastCount = n;
          this.banner = this.timer > COUNTDOWN ? `ROUND ${this.round}` : String(n);
          if (this.timer <= COUNTDOWN) audio.play('hover');
        }
      } else {
        this.phase = 'fight';
        this.banner = 'FIGHT';
        p.frozen = false;
        audio.play('doorClose');
        window.setTimeout(() => {
          if (this.phase === 'fight' && this.banner === 'FIGHT') this.banner = '';
        }, 700);
      }
    } else if (this.phase === 'between') {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.round++;
        this.resetRound();
      }
    }

    // my state, 20 times a second
    this.sendT -= dt;
    if (this.sendT <= 0) {
      this.sendT = 1 / STATE_HZ;
      this.net.send({
        t: 'st',
        x: Math.round(p.x), y: Math.round(p.y), a: +p.aim.toFixed(3),
        r: p.rolling ? 1 : 0, w: p.weapon.def.id, hp: p.hp, rl: p.reloading ? 1 : 0,
      });
    }
  }

  // ------------------------------------------------------------ net out

  sendShot(weapon: string, bullets: number[][], hpDmg: number): void {
    this.net.send({ t: 'sh', w: weapon, b: bullets, d: hpDmg });
  }

  /** The local player just died (called from GameScene.onPlayerDied). */
  onMyDeath(): void {
    if (this.phase !== 'fight' && this.phase !== 'between') return;
    this.net.send({ t: 'dead' });
    this.score.opp++;
    this.endRound(false);
  }

  // ------------------------------------------------------------ net in

  private onMsg(m: NetMsg): void {
    const r = this.remote;
    switch (m.t) {
      case 'st':
        r.tx = Number(m.x);
        r.ty = Number(m.y);
        r.taim = Number(m.a);
        r.rolling = m.r === 1;
        r.reloading = m.rl === 1;
        r.hp = Number(m.hp);
        r.setWeapon(String(m.w));
        break;
      case 'sh':
        this.onRemoteShot(m);
        break;
      case 'dead':
        if (this.phase !== 'fight' && this.phase !== 'between') break;
        this.score.me++;
        this.scene.fx.blood(r.x, r.y, 0, 4);
        this.scene.fx.debris(r.x, r.y, 0, 12, 0x30495a, 'chunk', 460, Math.PI);
        this.scene.fx.ring(r.x, r.y, 30, 500, 0.6, 0xffffff, 0.8);
        audio.play('death', 0.7);
        r.setAlive(false);
        this.endRound(true);
        break;
      case 'again':
        this.oppAgain = true;
        this.checkRematch();
        break;
      case 'settled':
        this.settle = { outcome: String(m.outcome), amount: String(m.amount ?? '0') };
        break;
      case 'left':
        this.onClosed();
        break;
    }
  }

  private onRemoteShot(m: NetMsg): void {
    const s = this.scene;
    const r = this.remote;
    const def = WEAPONS[String(m.w)];
    if (!def || !Array.isArray(m.b) || !r.alive) return;
    const dmg = Math.max(1, Math.min(6, Number(m.d) || 1));
    let first = true;
    for (const raw of m.b as number[][]) {
      const [x, y, ang, speed, br, life] = raw;
      if (![x, y, ang, speed, br, life].every(Number.isFinite)) continue;
      const b = s.bullets.fireEnemy(x, y, ang, Math.min(speed, 3000), { tex: 'ebFast', r: br * 1.15, life: Math.min(life, 2) });
      if (!b) break;
      b.dmg = dmg;
      b.img.setScale(1);
      if (first) {
        first = false;
        s.fx.muzzle(x, y, ang, 0.55 + def.shake * 1.6);
        audio.play(def.sfx, 0.55);
        r.recoil();
      }
    }
  }

  // ------------------------------------------------------------ rounds

  private endRound(iWon: boolean): void {
    if (this.phase === 'between' || this.phase === 'over') return;
    const s = this.scene;
    s.fx.slowmo(0.3, 0.8);
    if (this.score.me >= WIN_SCORE || this.score.opp >= WIN_SCORE) {
      this.phase = 'over';
      const won = this.score.me >= WIN_SCORE && this.score.me > this.score.opp;
      this.banner = won ? 'VICTORY' : 'DEFEAT';
      if (this.score.me === this.score.opp) this.banner = 'DRAW';
      audio.play(won ? 'clear' : 'death');
      this.reportResult(won ? 'me' : this.score.me === this.score.opp ? 'draw' : 'opp');
      return;
    }
    this.phase = 'between';
    this.timer = BETWEEN;
    this.banner = iWon ? 'ROUND WON' : 'ROUND LOST';
  }

  /** Tell the relay who won, from my side. The money moves only if the other player says the same. */
  private reportResult(w: 'me' | 'opp' | 'draw'): void {
    if (this.reported || this.stake <= 0n) return;
    this.reported = true;
    this.net.send({ t: 'result', w });
  }

  /** Rematch is free play only: a new bet needs a new room. */
  askRematch(): void {
    this.myAgain = true;
    this.net.send({ t: 'again' });
    this.checkRematch();
  }

  private checkRematch(): void {
    if (!(this.myAgain && this.oppAgain)) return;
    this.myAgain = this.oppAgain = false;
    this.score = { me: 0, opp: 0 };
    this.round = 1;
    this.resetRound(true);
  }

  private onClosed(): void {
    if (this.phase === 'left') return;
    this.phase = 'left';
    this.banner = 'OPPONENT LEFT';
    this.scene.player.frozen = true;
  }

  // ------------------------------------------------------------ teardown

  /** Drop the connection and the puppet. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const f of this.off) f();
    this.off = [];
    this.net.close();
    this.remote.destroy();
  }

  leave(): void {
    this.dispose();
    this.scene.scene.stop('VsHud');
    this.scene.scene.stop('UI');
    this.scene.scene.stop('Game');
    this.scene.scene.start('Menu');
  }
}

