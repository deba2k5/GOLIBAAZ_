import Phaser from 'phaser';
import { DEPTH } from '../config';
import { audio } from '../core/audio';
import { TAU, clamp, damp, deg } from '../core/math';
import { rnd } from '../core/rng';
import { WEAPON_GRIP_X, WEAPON_TEX_W } from '../gfx/textures';
import type { GameScene } from '../scenes/GameScene';
import { type WeaponInst, makeWeapon } from './weapons';

export interface Controls {
  mx: number;
  my: number;
  aimX: number;
  aimY: number;
  fire: boolean;
  roll: boolean;
  reload: boolean;
  interact: boolean;
  blank: boolean;
  /** Weapon slot to select, or -1. */
  slot: number;
  /** -1 / +1 to cycle weapons, 0 for none. */
  cycle: number;
}

export const emptyControls = (): Controls => ({
  mx: 0, my: 0, aimX: 0, aimY: 0, fire: false, roll: false, reload: false, interact: false, blank: false, slot: -1, cycle: 0,
});

const ROLL_DUR = 0.4;
/** Point-blank shots start this far (px) before the barrel line's closest point to the enemy, so the
 * bullet's first collision sub-step (at most 14 px) lands inside the enemy's circle. */
const POINT_BLANK_BACK = 8;
const ROLL_SPEED = 720;
const ROLL_IFRAMES = 0.34;
const MAX_WEAPONS = 4;
/** Active-reload sweet spot, as a fraction of the reload bar. */
export const PERFECT_START = 0.36;
export const PERFECT_END = 0.54;

export class Player {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** Recoil push, decays quickly. */
  kx = 0;
  ky = 0;
  aim = 0;
  r = 17;
  hitR = 10;
  hp = 6;
  armor = 0;
  blanks = 2;
  weapons: WeaponInst[] = [makeWeapon('pistol')];
  cur = 0;
  fireCd = 0;
  reloading = false;
  reloadT = 0;
  reloadDur = 1;
  reloadTried = false;
  burstLeft = 0;
  burstT = 0;
  spin = 0;
  rollT = 0;
  rollCd = 0;
  rollDx = 1;
  rollDy = 0;
  rollBuffer = 0;
  invuln = 0;
  dead = false;
  god = false;
  adrenalineT = 0;
  killsSinceHeal = 0;
  frozen = false;
  private gunKick = 0;
  private stepT = 0;
  private emptyT = 0;

  shadow: Phaser.GameObjects.Image;
  body: Phaser.GameObjects.Image;
  gun: Phaser.GameObjects.Image;

  constructor(private scene: GameScene) {
    this.shadow = scene.add.image(0, 0, 'shadow').setDepth(DEPTH.SHADOW).setScale(0.95);
    this.gun = scene.add.image(0, 0, 'w_pistol').setDepth(DEPTH.PLAYER).setOrigin(WEAPON_GRIP_X / WEAPON_TEX_W, 0.5);
    this.body = scene.add.image(0, 0, 'player').setDepth(DEPTH.PLAYER);
  }

  get weapon(): WeaponInst {
    return this.weapons[this.cur];
  }

  get rolling(): boolean {
    return this.rollT > 0;
  }

  get maxHp(): number {
    return this.scene.run.stats.hearts * 2;
  }

  clipSize(w: WeaponInst = this.weapon): number {
    return Math.max(1, Math.round(w.def.clip * this.scene.run.stats.clip));
  }

  setPos(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = this.vy = this.kx = this.ky = 0;
    this.syncSprites(0);
  }

  // ------------------------------------------------------------ update

  update(dt: number, c: Controls, time: number): void {
    const s = this.scene;
    const stats = s.run.stats;
    if (this.dead) return;

    this.invuln = Math.max(0, this.invuln - dt);
    this.adrenalineT = Math.max(0, this.adrenalineT - dt);
    this.rollCd = Math.max(0, this.rollCd - dt);
    this.rollBuffer = Math.max(0, this.rollBuffer - dt);
    this.fireCd -= dt;
    this.emptyT -= dt;
    this.gunKick = damp(this.gunKick, 0, 16, dt);

    if (this.frozen) {
      this.vx = damp(this.vx, 0, 14, dt);
      this.vy = damp(this.vy, 0, 14, dt);
      this.syncSprites(time);
      return;
    }

    const aimDx = c.aimX - this.x;
    const aimDy = c.aimY - this.y;
    if (aimDx * aimDx + aimDy * aimDy > 16) this.aim = Math.atan2(aimDy, aimDx);

    let mx = c.mx;
    let my = c.my;
    const ml = Math.hypot(mx, my);
    if (ml > 1) {
      mx /= ml;
      my /= ml;
    }

    // ---- dodge roll
    if (c.roll) this.rollBuffer = 0.14;
    if (this.rollBuffer > 0 && !this.rolling && this.rollCd <= 0) {
      this.rollBuffer = 0;
      if (ml > 0.1) {
        this.rollDx = mx / Math.max(ml > 1 ? 1 : ml, 0.0001);
        this.rollDy = my / Math.max(ml > 1 ? 1 : ml, 0.0001);
        const l = Math.hypot(this.rollDx, this.rollDy) || 1;
        this.rollDx /= l;
        this.rollDy /= l;
      } else {
        this.rollDx = Math.cos(this.aim);
        this.rollDy = Math.sin(this.aim);
      }
      this.rollT = ROLL_DUR;
      this.burstLeft = 0;
      audio.play('roll');
      s.fx.dust(this.x, this.y, 6, 0xb8a890, 130, 0.7);
      s.run.rolls++;
      if (stats.rollReload > 0 && this.weapon.clip < this.clipSize()) {
        const w = this.weapon;
        const want = Math.ceil(this.clipSize() * stats.rollReload);
        const take = Math.min(want, this.clipSize() - w.clip, w.reserve < 0 ? 9999 : w.reserve);
        if (take > 0) {
          w.clip += take;
          if (w.reserve >= 0) w.reserve -= take;
          if (this.reloading && w.clip >= this.clipSize()) this.reloading = false;
        }
      }
    }

    if (this.rolling) {
      this.rollT -= dt;
      const k = 1 - this.rollT / ROLL_DUR;
      const sp = ROLL_SPEED * stats.rollDist * (1.12 - 0.5 * k);
      this.vx = this.rollDx * sp;
      this.vy = this.rollDy * sp;
      if (Math.random() < dt * 40) s.fx.dust(this.x, this.y, 1, 0xb8a890, 40, 0.5);
      if (this.rollT <= 0) {
        this.rollCd = 0.26 * stats.rollCd;
        this.vx *= 0.45;
        this.vy *= 0.45;
      }
    } else {
      const slow = this.weapon.def.spinUp && this.spin > 0.2 ? 0.62 : 1;
      const speed = 335 * stats.speed * slow;
      this.vx = damp(this.vx, mx * speed, 20, dt);
      this.vy = damp(this.vy, my * speed, 20, dt);
      if (ml > 0.1) {
        this.stepT -= dt;
        if (this.stepT <= 0) {
          this.stepT = 0.24;
          s.fx.dust(this.x - mx * 8, this.y - my * 8, 1, 0xb8a890, 26, 0.38);
        }
      }
    }

    // recoil push
    const kd = Math.exp(-10 * dt);
    this.kx *= kd;
    this.ky *= kd;

    s.room.collide(this.x + (this.vx + this.kx) * dt, this.y + (this.vy + this.ky) * dt, this.r, false);
    this.x = s.room.cx;
    this.y = s.room.cy;

    // ---- weapons
    if (c.slot >= 0 && c.slot < this.weapons.length) this.switchTo(c.slot);
    else if (c.cycle !== 0 && this.weapons.length > 1) {
      this.switchTo((this.cur + c.cycle + this.weapons.length) % this.weapons.length);
    }

    const w = this.weapon;
    const def = w.def;
    const canAct = !this.rolling;

    if (this.reloading) {
      this.reloadT += dt;
      if (c.reload && !this.reloadTried && this.reloadT > 0.12) {
        const f = this.reloadT / this.reloadDur;
        this.reloadTried = true;
        if (f >= PERFECT_START && f <= PERFECT_END) {
          this.finishReload(true);
        } else {
          this.reloadDur += 0.4;
          audio.play('jam');
          s.fx.text(this.x, this.y - 44, 'JAMMED', '#d8452f', 22, 0.6);
        }
      }
      if (this.reloading && this.reloadT >= this.reloadDur) this.finishReload(false);
    } else if (c.reload) {
      this.startReload();
    }

    const wantFire = c.fire && canAct;
    if (def.spinUp) {
      const spinning = wantFire && w.clip > 0 && !this.reloading;
      this.spin = clamp(this.spin + (spinning ? dt / 0.7 : -dt * 2), 0, 1);
    } else {
      this.spin = 0;
    }

    if (this.burstLeft > 0 && canAct) {
      this.burstT -= dt;
      if (this.burstT <= 0) {
        this.burstT = 0.065;
        this.burstLeft--;
        if (w.clip > 0) this.shoot();
        else this.burstLeft = 0;
      }
    } else if (wantFire && this.fireCd <= 0 && !this.reloading) {
      if (w.clip <= 0) {
        if (w.reserve === 0) {
          if (this.emptyT <= 0) {
            this.emptyT = 0.5;
            audio.play('empty');
            s.fx.text(this.x, this.y - 44, 'OUT OF AMMO', '#d8452f', 22, 0.7);
            this.switchTo(0);
          }
        } else {
          this.startReload();
        }
      } else {
        let rate = def.rate * stats.fireRate;
        if (this.adrenalineT > 0) rate *= 1.6;
        if (def.spinUp) rate *= 0.3 + 0.7 * this.spin;
        this.fireCd = 1 / rate;
        this.shoot();
        if (def.burst) {
          this.burstLeft = def.burst - 1;
          this.burstT = 0.065;
        }
      }
    }

    this.syncSprites(time);
  }

  private syncSprites(time: number): void {
    this.shadow.setPosition(this.x + 4, this.y + 6);
    this.body.setPosition(this.x, this.y);
    if (this.rolling) {
      const k = 1 - this.rollT / ROLL_DUR;
      this.body.rotation = Math.atan2(this.rollDy, this.rollDx) + k * TAU;
      const sq = 1 - Math.sin(k * Math.PI) * 0.2;
      this.body.setScale(sq);
      this.gun.setVisible(false);
      this.shadow.setScale(0.95 * sq);
    } else {
      this.body.rotation = this.aim;
      this.body.setScale(1);
      this.shadow.setScale(0.95);
      const back = this.gunKick * 9;
      let rot = this.aim;
      if (this.reloading) rot += Math.sin((this.reloadT / this.reloadDur) * Math.PI) * 0.55;
      this.gun.setVisible(true)
        .setPosition(this.x + Math.cos(this.aim) * (20 - back), this.y + Math.sin(this.aim) * (20 - back))
        .setRotation(rot);
    }
    const blink = this.invuln > 0 && !this.rolling && Math.floor(time / 70) % 2 === 0;
    this.body.setAlpha(blink ? 0.35 : 1);
    this.gun.setAlpha(blink ? 0.35 : 1);
  }

  // ------------------------------------------------------------ shooting

  private shoot(): void {
    const s = this.scene;
    const stats = s.run.stats;
    const w = this.weapon;
    const def = w.def;
    w.clip--;
    const last = w.clip === 0;

    const ca = Math.cos(this.aim);
    const sa = Math.sin(this.aim);
    let mx = this.x + ca * def.muzzle;
    let my = this.y + sa * def.muzzle;
    // if the barrel is poking into a wall, fire from the body instead
    if (s.room.solidAt(mx, my, false) || s.room.solidAt(this.x + ca * def.muzzle * 0.5, this.y + sa * def.muzzle * 0.5, false)) {
      mx = this.x + ca * 8;
      my = this.y + sa * 8;
    }
    // the flash stays at the barrel; only the bullets may start further back
    const flashX = mx;
    const flashY = my;
    // an enemy pressed against the player is already past the muzzle: start the bullets just short of
    // the closest point of the barrel line to it, so a point-blank shot connects
    const reach = Math.hypot(mx - this.x, my - this.y);
    let startT = reach;
    for (const e of s.enemies.list) {
      if (e.dead || e.spawnT > 0) continue;
      const ex = e.x - this.x;
      const ey = e.y - this.y;
      const t = clamp(ex * ca + ey * sa, 0, reach);
      const dx = ex - ca * t;
      const dy = ey - sa * t;
      if (dx * dx + dy * dy <= e.r * e.r) startT = Math.min(startT, t - POINT_BLANK_BACK);
    }
    if (startT < reach) {
      mx = this.x + ca * startT;
      my = this.y + sa * startT;
    }

    let dmgMul = stats.dmg;
    if (w.perfect) dmgMul *= 1.25;
    if (stats.lastRound && last) dmgMul *= 3;
    if (stats.comboKing && s.run.combo >= 10) dmgMul *= 1.25;
    const spread = deg(def.spread) * stats.spread;

    const sent: number[][] = [];
    for (let i = 0; i < def.pellets; i++) {
      const ang = this.aim + (Math.random() - 0.5) * spread;
      const speed = def.speed * stats.bulletSpeed * (def.pellets > 1 ? rnd(0.82, 1.08) : 1);
      const crit = Math.random() < stats.crit;
      const b = s.bullets.firePlayer(def.bullet, mx, my, ang, speed, def.bulletR, def.dmg * dmgMul * (crit ? 2 : 1), def.life);
      if (!b) break;
      if (s.versus) sent.push([Math.round(mx), Math.round(my), +ang.toFixed(4), Math.round(speed), def.bulletR, def.life]);
      b.pierce = def.pierce + stats.pierce;
      b.bounce = def.bounce + stats.bounce;
      b.knock = def.knock;
      b.crit = crit;
      b.explodeR = def.explodeR ?? 0;
      if (crit || (stats.lastRound && last)) b.img.setTint(0xffc94a).setScale(1.25);
      else if (w.perfect) b.img.setTint(0xfff0b0);
    }

    if (s.versus && sent.length) s.versus.sendShot(def.id, sent, Math.max(1, Math.round((def.dmg * dmgMul) / 14)));

    this.kx -= ca * def.kick * stats.kick;
    this.ky -= sa * def.kick * stats.kick;
    this.gunKick = 1;
    s.fx.muzzle(flashX, flashY, this.aim, 0.55 + def.shake * 1.6);
    if (def.shell) s.fx.shell(this.x + ca * 16, this.y + sa * 16, this.aim, def.shell);
    s.fx.shake(def.shake * 0.8);
    s.fx.kick(this.aim + Math.PI, 5 + def.shake * 34);
    audio.play(def.sfx);
    s.run.shots++;

    if (last) {
      this.burstLeft = 0;
      if (w.reserve !== 0) this.startReload();
    }
  }

  startReload(): boolean {
    const w = this.weapon;
    if (this.reloading || w.clip >= this.clipSize() || w.reserve === 0) return false;
    this.reloading = true;
    this.reloadT = 0;
    this.reloadDur = w.def.reload / this.scene.run.stats.reload;
    this.reloadTried = false;
    this.burstLeft = 0;
    audio.play('reload');
    return true;
  }

  private finishReload(perfect: boolean): void {
    const w = this.weapon;
    const need = this.clipSize() - w.clip;
    const take = w.reserve < 0 ? need : Math.min(need, w.reserve);
    w.clip += take;
    if (w.reserve >= 0) w.reserve -= take;
    w.perfect = perfect;
    this.reloading = false;
    this.fireCd = Math.min(this.fireCd, 0.05);
    if (perfect) {
      audio.play('perfect');
      this.scene.fx.text(this.x, this.y - 46, 'PERFECT', '#ffd24a', 26, 0.7);
      this.scene.fx.ring(this.x, this.y, 20, 70, 0.25, 0xffd24a, 0.7, 'ringThin');
      this.scene.run.perfects++;
    } else {
      audio.play('reloadDone');
    }
  }

  switchTo(i: number): void {
    if (i === this.cur || i < 0 || i >= this.weapons.length) return;
    this.cur = i;
    this.reloading = false;
    this.burstLeft = 0;
    this.spin = 0;
    this.fireCd = Math.max(this.fireCd, 0.18);
    this.gun.setTexture(`w_${this.weapon.def.id}`);
    this.gunKick = 0.8;
    audio.play('swap');
  }

  /**
   * Takes a weapon. Returns the weapon that had to be dropped to make room, if any.
   * Picking up a duplicate just tops up its ammo.
   */
  giveWeapon(inst: WeaponInst): WeaponInst | null {
    const have = this.weapons.find((w) => w.def.id === inst.def.id);
    if (have) {
      if (have.reserve >= 0) have.reserve = Math.min(have.def.reserve, have.reserve + Math.ceil(have.def.reserve * 0.5));
      return null;
    }
    let dropped: WeaponInst | null = null;
    if (this.weapons.length >= MAX_WEAPONS) {
      const slot = this.cur === 0 ? 1 : this.cur;
      dropped = this.weapons[slot];
      this.weapons[slot] = inst;
      this.cur = -1;
      this.switchTo(slot);
    } else {
      this.weapons.push(inst);
      this.switchTo(this.weapons.length - 1);
    }
    return dropped;
  }

  /** Refill reserve ammo on every gun by a fraction of its maximum. */
  addAmmo(frac: number): boolean {
    let any = false;
    for (const w of this.weapons) {
      if (w.reserve < 0 || w.reserve >= w.def.reserve) continue;
      w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.reserve * frac));
      any = true;
    }
    return any;
  }

  needsAmmo(): boolean {
    return this.weapons.some((w) => w.reserve >= 0 && w.reserve < w.def.reserve);
  }

  heal(n: number): boolean {
    if (this.hp >= this.maxHp) return false;
    this.hp = Math.min(this.maxHp, this.hp + n);
    return true;
  }

  // ------------------------------------------------------------ damage

  /** Returns true if the hit landed (false while rolling or invulnerable). */
  hurt(ang: number, dmg = 1): boolean {
    if (this.dead || this.invuln > 0 || this.frozen) return false;
    if (this.rolling && this.rollT > ROLL_DUR - ROLL_IFRAMES) return false;
    const s = this.scene;
    const vs = !!s.versus;
    if (this.god) {
      this.invuln = 0.4;
      s.run.damageTaken++;
      return true;
    }
    s.run.damageTaken++;
    // versus: every bullet counts (no grace period), hits shove less and never freeze the frame
    this.invuln = vs ? 0 : 1.25;
    const push = vs ? 70 : 260;
    this.kx += Math.cos(ang) * push;
    this.ky += Math.sin(ang) * push;
    s.fx.shake(vs ? 0.3 : 0.7);
    if (!vs) s.fx.hitstop(0.1);
    s.breakCombo();
    if (this.armor > 0) {
      this.armor--;
      audio.play('shield', 2);
      audio.play('hurt', 0.5);
      s.fx.sparks(this.x, this.y, 0, 12, 0xcfe4ff, Math.PI, 420);
      s.fx.text(this.x, this.y - 44, 'ARMOR BROKEN', '#9fc8ea', 22, 0.8);
    } else {
      this.hp -= dmg;
      audio.play('hurt');
      s.fx.blood(this.x, this.y, ang, 1.5);
      s.events.emit('hurt');
    }
    s.fx.ring(this.x, this.y, 30, 190, 0.3, 0xffffff, 0.7, 'ringThin');
    // mercy: sweep away bullets that are already on top of the player (not in versus: a shotgun
    // blast is a volley of bullets that should each land)
    if (!vs) {
      for (const b of s.bullets.list) {
        if (!b.active || b.friendly) continue;
        const dx = b.x - this.x;
        const dy = b.y - this.y;
        if (dx * dx + dy * dy < 150 * 150) b.life = 0;
      }
    }
    if (s.run.stats.adrenaline) this.adrenalineT = 4;
    if (this.hp <= 0) {
      this.dead = true;
      this.body.setVisible(false);
      this.gun.setVisible(false);
      this.shadow.setVisible(false);
      s.onPlayerDied();
    }
    return true;
  }

  destroy(): void {
    this.shadow.destroy();
    this.body.destroy();
    this.gun.destroy();
  }
}
