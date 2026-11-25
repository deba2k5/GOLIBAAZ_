// Automated full-run playtest: the built-in bot plays the game while this script watches for
// errors and stalls. usage: node tools/playtest.mjs [seed] [speed] [god=1|0] [maxSeconds] [extraQuery]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [seed = '1', speed = '6', god = '1', maxSec = '240', extra = ''] = process.argv.slice(2);
const port = process.env.PORT ?? '5173';
fs.mkdirSync('tools/shots', { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[error] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 6).join('\n')}`));

const q = `bot=1&seed=${seed}&speed=${speed}${god === '1' ? '&god=1' : ''}${extra ? '&' + extra : ''}`;
await page.goto(`http://localhost:${port}/?${q}`);
await page.waitForTimeout(1500);

const state = () => page.evaluate(() => {
  const s = window.__golibaaz;
  if (!s || !s.run || !s.room) return null;
  const p = s.player;
  return {
    t: Math.round(s.run.time), floor: s.run.floorIndex + 1, loop: s.run.loop, room: s.room.node.id, type: s.room.node.type,
    visited: s.run.plan.rooms.filter((r) => r.visited).length, rooms: s.run.plan.rooms.length,
    kills: s.run.kills, hp: p.hp, maxHp: p.maxHp, hits: s.run.damageTaken, coins: s.run.coins, score: s.run.score,
    weapons: p.weapons.map((w) => w.def.id).join(','), ups: Object.keys(s.run.upgrades).length,
    en: s.enemies.list.length, eb: s.bullets.enemyCount, boss: s.bossEnemy ? Math.round(s.bossEnemy.hp) : -1,
    done: s.bot ? s.bot.done : null, fps: Math.round(s.game.loop.actualFps), x: Math.round(p.x), y: Math.round(p.y),
    active: s.roomActive, modal: s.modal, types: s.enemies.list.map((e) => e.type + ':' + Math.round(e.hp)).join(','),
  };
});

let last = '';
let stall = 0;
let lastKey = '';
let shots = 0;
let result = 'timeout';
const t0 = Date.now();
const seenFloors = new Set();
while ((Date.now() - t0) / 1000 < Number(maxSec)) {
  await page.waitForTimeout(1000);
  const st = await state();
  if (!st) continue;
  const line = `t=${st.t}s F${st.floor}${st.loop ? '+L' + st.loop : ''} room ${st.room}(${st.type}) ${st.visited}/${st.rooms} kills=${st.kills} hp=${st.hp}/${st.maxHp} hits=${st.hits} coins=${st.coins} w=[${st.weapons}] ups=${st.ups} en=${st.en} eb=${st.eb}${st.boss >= 0 ? ' boss=' + st.boss : ''} fps=${st.fps}`;
  if (line !== last) console.log(line + (st.en > 0 && st.en <= 2 ? ` {${st.types}}` : ''));
  last = line;
  // capture a few interesting moments
  if (st.type === 'boss' && st.boss > 0 && !seenFloors.has('b' + st.floor) && st.eb > 25) {
    seenFloors.add('b' + st.floor);
    await page.screenshot({ path: `tools/shots/pt_boss${st.floor}_s${seed}.png` });
  }
  if (st.type === 'combat' && st.en >= 4 && st.eb >= 6 && !seenFloors.has('c' + st.floor)) {
    seenFloors.add('c' + st.floor);
    await page.screenshot({ path: `tools/shots/pt_combat${st.floor}_s${seed}.png` });
  }
  if ((st.type === 'shop' || st.type === 'treasure') && !seenFloors.has(st.type + st.floor) && shots < 8) {
    seenFloors.add(st.type + st.floor);
    shots++;
    await page.screenshot({ path: `tools/shots/pt_${st.type}${st.floor}_s${seed}.png` });
  }
  if (st.done) {
    result = st.done;
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `tools/shots/pt_end_s${seed}.png` });
    break;
  }
  // stall detection: nothing at all changing for a long time
  const key = `${st.floor}:${st.room}:${st.kills}:${st.x >> 4}:${st.y >> 4}:${st.boss}:${st.en}`;
  stall = key === lastKey ? stall + 1 : 0;
  lastKey = key;
  if (stall >= 25) {
    result = 'STALLED';
    await page.screenshot({ path: `tools/shots/pt_stall_s${seed}.png` });
    console.log('stalled state:', JSON.stringify(st));
    break;
  }
  if (errors.length) {
    result = 'ERROR';
    await page.screenshot({ path: `tools/shots/pt_error_s${seed}.png` });
    break;
  }
}
console.log(`RESULT seed=${seed}: ${result} after ${Math.round((Date.now() - t0) / 1000)}s real`);
if (errors.length) console.log(`ERRORS:\n${[...new Set(errors)].slice(0, 8).join('\n')}`);
await browser.close();
process.exit(result === 'victory' || result === 'dead' ? 0 : 1);
