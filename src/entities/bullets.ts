import Phaser from 'phaser';
import { DEPTH } from '../config';
import { audio } from '../core/audio';
import { rnd } from '../core/rng';
import type { GameScene } from '../scenes/GameScene';

export interface Bullet {
  active: boolean;
  friendly: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  dmg: number;
  life: number;
  pierce: number;
  bounce: number;
  knock: number;
  crit: boolean;
  explodeR: number;
  /** Speed change per second, as a fraction (0.5 = +50%/s). */
  accel: number;
  maxSpeed: number;
  /** Turn rate in rad/s. */
  curve: number;
  round: boolean;
  hitIds: number[];
  img: Phaser.GameObjects.Image;
}

interface Lob {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
  dur: number;
  radius: number;
  img: Phaser.GameObjects.Image;
  shadow: Phaser.GameObjects.Image;
  mark: Phaser.GameObjects.Image;
}

export interface EnemyShot {
  tex?: string;
  r?: number;
  life?: number;
  accel?: number;
  maxSpeed?: number;
  curve?: number;
}

const MAX_BULLETS = 900;

export class Bullets {
  list: Bullet[] = [];
  private free: Bullet[] = [];
  private lobs: Lob[] = [];
  enemyCount = 0;

  constructor(private scene: GameScene) {}

  private alloc(tex: string): Bullet | null {
    let b = this.free.pop();
    if (!b) {
      if (this.list.length >= MAX_BULLETS) return null;
      b = {
        active: false, friendly: false, x: 0, y: 0, vx: 0, vy: 0, r: 4, dmg: 1, life: 1, pierce: 0, bounce: 0, knock: 0,
        crit: false, explodeR: 0, accel: 0, maxSpeed: 0, curve: 0, round: false, hitIds: [],
        img: this.scene.add.image(0, 0, tex),
      };
      this.list.push(b);
    }
    b.active = true;
    b.hitIds.length = 0;
    b.pierce = 0;
    b.bounce = 0;
    b.knock = 0;
    b.crit = false;
    b.explodeR = 0;
    b.accel = 0;
    b.maxSpeed = 0;
    b.curve = 0;
    b.img.setTexture(tex).setVisible(true).setAlpha(1).setScale(1).setTint(0xffffff);
    return b;
  }

  firePlayer(tex: string, x: number, y: number, ang: number, speed: number, r: number, dmg: number, life: number): Bullet | null {
    const b = this.alloc(tex);
    if (!b) return null;
    b.friendly = true;
    b.x = x;
    b.y = y;
    b.vx = Math.cos(ang) * speed;
    b.vy = Math.sin(ang) * speed;
    b.r = r;
    b.dmg = dmg;
    b.life = life;
    b.round = tex === 'pbGrenade';
    b.img.setDepth(DEPTH.PBULLET).setOrigin(b.round ? 0.5 : 0.85, 0.5).setRotation(ang).setPosition(x, y);
    return b;
  }

  fireEnemy(x: number, y: number, ang: number, speed: number, o: EnemyShot = {}): Bullet | null {
    const tex = o.tex ?? 'eb';
    const b = this.alloc(tex);
    if (!b) return null;
    b.friendly = false;
    b.x = x;
    b.y = y;
    b.vx = Math.cos(ang) * speed;
    b.vy = Math.sin(ang) * speed;
    b.r = o.r ?? (tex === 'ebBig' ? 15 : tex === 'ebSmall' ? 6.5 : tex === 'ebFast' ? 7 : 9);
    b.dmg = 1;
    b.life = o.life ?? 6;
    b.accel = o.accel ?? 0;
    b.maxSpeed = o.maxSpeed ?? 0;
    b.curve = o.curve ?? 0;
    b.round = tex !== 'ebFast';
    b.img.setDepth(DEPTH.EBULLET).setOrigin(b.round ? 0.5 : 0.8, 0.5).setRotation(b.round ? 0 : ang).setPosition(x, y);
    b.img.setScale(0.4);
    return b;
  }

  /** A grenade thrown in an arc that explodes where it lands. */
  lob(x0: number, y0: number, x1: number, y1: number, dur: number, radius: number): void {
    const s = this.scene;
    const mark = s.add.image(x1, y1, 'telegraph').setDepth(DEPTH.GROUNDFX).setScale(0.2).setAlpha(0);
    const shadow = s.add.image(x0, y0, 'shadow').setDepth(DEPTH.SHADOW).setScale(0.4);
    const img = s.add.image(x0, y0, 'grenade').setDepth(DEPTH.EBULLET);
    this.lobs.push({ x0, y0, x1, y1, t: 0, dur, radius, img, shadow, mark });
    audio.play('lob');
  }

  private kill(b: Bullet): void {
    b.active = false;
    b.img.setVisible(false);
    this.free.push(b);
  }

  update(dt: number): void {
    const scene = this.scene;
    const room = scene.room;
    const player = scene.player;
    const enemies = scene.enemies.list;
    let enemyCount = 0;

    for (const b of this.list) {
      if (!b.active) continue;
      b.life -= dt;
      if (b.life <= 0) {
        if (b.explodeR > 0) scene.explode(b.x, b.y, b.explodeR, { enemyDmg: b.dmg, hurtPlayer: false });
        this.kill(b);
        continue;
      }
      if (b.accel !== 0) {
        const k = 1 + b.accel * dt;
        const sp2 = b.vx * b.vx + b.vy * b.vy;
        if (b.maxSpeed <= 0 || b.accel < 0 || sp2 < b.maxSpeed * b.maxSpeed) {
          b.vx *= k;
          b.vy *= k;
        }
      }
      if (b.curve !== 0) {
        const c = Math.cos(b.curve * dt);
        const s = Math.sin(b.curve * dt);
        const vx = b.vx * c - b.vy * s;
        b.vy = b.vx * s + b.vy * c;
        b.vx = vx;
      }

      const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      const steps = Math.max(1, Math.ceil((speed * dt) / 14));
      const sdt = dt / steps;
      let dead = false;

      for (let s = 0; s < steps && !dead; s++) {
        const px = b.x;
        const py = b.y;
        b.x += b.vx * sdt;
        b.y += b.vy * sdt;

        // --- world
        if (room.solidAt(b.x, b.y, false)) {
          const tx = Math.floor(b.x / 64);
          const ty = Math.floor(b.y / 64);
          const prop = room.propAt(tx, ty);
          const ang = Math.atan2(b.vy, b.vx);
          if (prop && b.friendly) scene.damageProp(prop, b.dmg, ang);
          if (b.bounce > 0 && !prop) {
            const freeX = !room.solidAt(px, b.y, false);
            const freeY = !room.solidAt(b.x, py, false);
            if (freeY && !freeX) b.vy = -b.vy;
            else if (freeX && !freeY) b.vx = -b.vx;
            else {
              b.vx = -b.vx;
              b.vy = -b.vy;
            }
            b.x = px;
            b.y = py;
            b.bounce--;
            b.hitIds.length = 0;
            scene.fx.sparks(px, py, Math.atan2(b.vy, b.vx), 3, 0xfff0c0, 0.7, 260);
            continue;
          }
          if (b.explodeR > 0) {
            scene.explode(px, py, b.explodeR, { enemyDmg: b.dmg, hurtPlayer: false });
          } else if (b.friendly) {
            scene.fx.sparks(px, py, ang + Math.PI, 4, 0xffe6b0, 0.9, 300);
            scene.fx.dust(px, py, 1, 0xa89880, 50, 0.4);
          } else {
            scene.fx.sparks(px, py, ang + Math.PI, 2, 0xff9a70, 0.9, 200);
          }
          dead = true;
          break;
        }

        if (b.friendly) {
          // --- enemies
          for (const e of enemies) {
            if (e.dead || e.spawnT > 0) continue;
            const dx = e.x - b.x;
            const dy = e.y - b.y;
            const rr = e.r + b.r;
            if (dx * dx + dy * dy > rr * rr) continue;
            if (b.hitIds.includes(e.id)) continue;
            if (b.explodeR > 0) {
              scene.explode(b.x, b.y, b.explodeR, { enemyDmg: b.dmg, hurtPlayer: false });
              dead = true;
              break;
            }
            const res = scene.enemies.hitByBullet(e, b);
            if (res === 'blocked') {
              dead = true;
              break;
            }
            b.hitIds.push(e.id);
            if (b.pierce > 0) {
              b.pierce--;
              b.dmg *= 0.85;
            } else {
              dead = true;
              break;
            }
          }
          // --- the other player (versus): damage is decided on their machine, this only stops the bullet
          const vs = scene.versus;
          if (!dead && vs && vs.remote.alive) {
            const dx = vs.remote.x - b.x;
            const dy = vs.remote.y - b.y;
            const rr = vs.remote.hitR + b.r * 0.8;
            if (!vs.remote.rolling && dx * dx + dy * dy < rr * rr) {
              scene.fx.sparks(b.x, b.y, Math.atan2(b.vy, b.vx) + Math.PI, 5, 0xff8a7a, 0.9, 320);
              vs.remote.flash();
              dead = true;
            }
          }
        } else if (!player.dead) {
          // --- player
          const dx = player.x - b.x;
          const dy = player.y - b.y;
          const rr = player.hitR + b.r * 0.8;
          if (dx * dx + dy * dy < rr * rr) {
            if (player.hurt(Math.atan2(b.vy, b.vx), b.dmg)) {
              dead = true;
              break;
            }
          }
        }
      }

      if (dead) {
        this.kill(b);
        continue;
      }
      b.img.setPosition(b.x, b.y);
      if (!b.round) b.img.rotation = Math.atan2(b.vy, b.vx);
      if (!b.friendly) {
        enemyCount++;
        // pop-in so freshly fired bullets are easy to read
        if (b.img.scaleX < 1) b.img.setScale(Math.min(1, b.img.scaleX + dt * 6));
      } else if (b.round) {
        b.img.rotation += dt * 12;
      }
    }
    this.enemyCount = enemyCount;

    // --- lobbed grenades
    for (const l of this.lobs) {
      l.t += dt;
      const p = Math.min(1, l.t / l.dur);
      const x = l.x0 + (l.x1 - l.x0) * p;
      const y = l.y0 + (l.y1 - l.y0) * p;
      const hgt = Math.sin(p * Math.PI);
      l.img.setPosition(x, y - hgt * 110).setScale(1 + hgt * 0.7);
      l.img.rotation += dt * 9;
      l.shadow.setPosition(x, y).setScale(0.5 - hgt * 0.15).setAlpha(0.8 - hgt * 0.3);
      l.mark.setScale((l.radius / 124) * (0.35 + 0.65 * p)).setAlpha(0.45 + 0.55 * p).setRotation(l.t * 1.5);
      if (p >= 1) {
        scene.explode(l.x1, l.y1, l.radius, { enemyDmg: 0, hurtPlayer: true });
        l.img.destroy();
        l.shadow.destroy();
        l.mark.destroy();
      }
    }
    this.lobs = this.lobs.filter((l) => l.t < l.dur);
  }

  /** Wipes enemy projectiles (blank, boss death, room clear). */
  clearEnemy(withFx = true): number {
    let n = 0;
    for (const b of this.list) {
      if (!b.active || b.friendly) continue;
      n++;
      if (withFx) {
        this.scene.fx.emit('soft', b.x, b.y, { life: rnd(0.2, 0.35), s0: 0.5, s1: 0.05, a0: 0.9, a1: 0, tint: 0xffd0a0, add: true, depth: DEPTH.GLOW });
      }
      this.kill(b);
    }
    for (const l of this.lobs) {
      l.img.destroy();
      l.shadow.destroy();
      l.mark.destroy();
    }
    this.lobs = [];
    this.enemyCount = 0;
    return n;
  }

  clearAll(): void {
    for (const b of this.list) if (b.active) this.kill(b);
    this.clearEnemy(false);
  }
}
