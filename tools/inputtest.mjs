// Drives the game with real mouse and keyboard events (no bot) and asserts that each control works.
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const port = process.env.PORT ?? '5173';
fs.mkdirSync('tools/shots', { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(0, 5).join('\n')}`));

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const st = () => page.evaluate(() => {
  const s = window.__golibaaz;
  const g = window.__game;
  const active = g.scene.getScenes(true).map((x) => x.scene.key);
  if (!s || !s.run || !s.player || !active.includes('Game')) return { active };
  const p = s.player;
  return {
    active, x: p.x, y: p.y, aim: p.aim, shots: s.run.shots, rolls: s.run.rolls, clip: p.weapon.clip, reloading: p.reloading,
    paused: s.paused, blanks: p.blanks, room: s.room.node.id, time: s.run.time, weapon: p.weapon.def.id, cur: p.cur,
    perfects: s.run.perfects, hp: p.hp, over: s.run.over, audio: !!window.__game && s.sound !== undefined,
  };
});

await page.goto(`http://localhost:${port}/`);
await page.waitForTimeout(2500);
let s = await st();
check('menu is showing', s.active.includes('Menu'), JSON.stringify(s.active));

// --- menu: open and close the help panel, then start
await page.mouse.move(960, 738);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/shots/in_help.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.mouse.move(960, 822);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({ path: 'tools/shots/in_options.png' });
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.mouse.move(960, 640);
await page.waitForTimeout(150);
await page.screenshot({ path: 'tools/shots/in_hover.png' });
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(1800);
s = await st();
check('START RUN starts the game', s.active.includes('Game') && s.active.includes('UI'), JSON.stringify(s.active));

// --- movement
const before = await st();
await page.keyboard.down('d');
await page.waitForTimeout(350);
await page.keyboard.up('d');
await page.keyboard.down('s');
await page.waitForTimeout(250);
await page.keyboard.up('s');
s = await st();
check('WASD moves the player', s.x > before.x + 40 && s.y > before.y + 20, `dx=${Math.round(s.x - before.x)} dy=${Math.round(s.y - before.y)}`);

// --- aim
await page.mouse.move(1500, 300);
await page.waitForTimeout(150);
s = await st();
check('mouse aims (up-right)', s.aim < -0.1 && s.aim > -1.5, `aim=${s.aim.toFixed(2)}`);
await page.mouse.move(400, 540);
await page.waitForTimeout(150);
s = await st();
check('mouse aims (left)', Math.abs(Math.abs(s.aim) - Math.PI) < 0.6, `aim=${s.aim.toFixed(2)}`);

// --- shooting
const shots0 = s.shots;
await page.mouse.down();
await page.waitForTimeout(700);
await page.screenshot({ path: 'tools/shots/in_shooting.png' });
await page.mouse.up();
s = await st();
check('holding left click fires repeatedly', s.shots - shots0 >= 3, `shots=${s.shots - shots0}`);
const afterShots = s.shots;
await page.waitForTimeout(300);
s = await st();
check('releasing stops firing', s.shots === afterShots);

// --- roll (space and right click)
const r0 = s.rolls;
const px = s.x;
await page.keyboard.down('a');
await page.keyboard.press('Space');
await page.waitForTimeout(500);
await page.keyboard.up('a');
s = await st();
check('SPACE dodge-rolls in the move direction', s.rolls === r0 + 1 && s.x < px - 100, `dx=${Math.round(s.x - px)}`);
await page.waitForTimeout(300);
await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
await page.waitForTimeout(500);
s = await st();
check('right click also rolls', s.rolls === r0 + 2);

// --- reload + perfect reload
await page.keyboard.press('r');
await page.waitForTimeout(120);
s = await st();
check('R starts a reload', s.reloading === true);
// the perfect window is 36%-54% of a 0.95s reload: aim for ~45%
await page.waitForTimeout(300);
await page.keyboard.press('r');
await page.waitForTimeout(150);
s = await st();
check('tapping R in the window gives a perfect reload', s.perfects === 1 && !s.reloading && s.clip === 10, `perfects=${s.perfects} clip=${s.clip}`);

// --- empty the clip: auto reload
await page.mouse.down();
await page.waitForTimeout(2300);
await page.mouse.up();
s = await st();
check('emptying the clip auto-reloads', s.reloading || s.clip === 10, `clip=${s.clip} reloading=${s.reloading}`);
await page.waitForTimeout(1200);

// --- blank
const b0 = (await st()).blanks;
await page.keyboard.press('q');
await page.waitForTimeout(250);
s = await st();
check('Q uses a blast', s.blanks === b0 - 1);

// --- pause / resume
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
s = await st();
check('ESC pauses', s.paused === true);
const t0 = s.time;
await page.waitForTimeout(500);
s = await st();
check('time stands still while paused', s.time === t0);
await page.mouse.move(960, 400);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(300);
s = await st();
check('RESUME button resumes', s.paused === false);
await page.waitForTimeout(300);
s = await st();
check('time runs again after resume', s.time > t0);

// --- weapon switching (give a second gun through the debug hook, then use keys + wheel)
await page.evaluate(() => {
  const s = window.__golibaaz;
  s.pickups.spawn('weapon', s.player.x, s.player.y, { weapon: 'shotgun' });
});
await page.waitForTimeout(300);
await page.keyboard.press('e');
await page.waitForTimeout(300);
s = await st();
check('E picks up a weapon', s.weapon === 'shotgun', s.weapon);
await page.keyboard.press('1');
await page.waitForTimeout(150);
s = await st();
check('1 selects the sidearm', s.weapon === 'pistol');
await page.mouse.wheel(0, 100);
await page.waitForTimeout(200);
s = await st();
check('mouse wheel cycles weapons', s.weapon === 'shotgun', s.weapon);
await page.mouse.move(1400, 540);
await page.mouse.down();
await page.waitForTimeout(120);
await page.screenshot({ path: 'tools/shots/in_shotgun.png' });
await page.mouse.up();
await page.waitForTimeout(400);

// --- point-blank: an enemy standing right on top of the player still gets hit
for (const [key, gun] of [['1', 'pistol'], ['2', 'shotgun']]) {
  await page.keyboard.press(key);
  await page.evaluate(() => {
    const s = window.__golibaaz;
    const p = s.player;
    p.god = true;
    p.reloading = false;
    p.weapon.clip = p.clipSize();
    const e = s.enemies.spawn('charger', p.x, p.y);
    e.hp = e.maxHp = 5000;
    window.__pb = e;
  });
  await page.waitForTimeout(400); // 0.3 s spawn-in
  const hp0 = await page.evaluate(() => {
    const e = window.__pb;
    e.stun = 5; // hold it in place on the player
    e.x = window.__golibaaz.player.x;
    e.y = window.__golibaaz.player.y;
    return e.hp;
  });
  await page.mouse.move(1400, 300);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(250);
  const r = await page.evaluate(() => {
    const s = window.__golibaaz;
    const e = window.__pb;
    const out = { hp: e.hp, weapon: s.player.weapon.def.id, d: Math.hypot(e.x - s.player.x, e.y - s.player.y) };
    s.enemies.kill(e);
    s.player.god = false;
    return out;
  });
  check(`point-blank ${gun} shot hits an enemy on top of the player`, r.weapon === gun && r.hp < hp0,
    `dmg=${Math.round(hp0 - r.hp)} dist=${Math.round(r.d)}`);
  await page.waitForTimeout(300);
}

// --- walk through a door into the next room
const dir = await page.evaluate(() => Object.keys(window.__golibaaz.room.node.doors)[0]);
const key = { n: 'w', s: 's', e: 'd', w: 'a' }[dir];
await page.evaluate((d) => {
  const s = window.__golibaaz;
  const c = s.room.doorCentre(d);
  const e = s.room.entry(d);
  s.player.setPos(e.x, e.y);
  void c;
}, dir);
const room0 = (await st()).room;
await page.keyboard.down(key);
await page.waitForTimeout(900);
await page.keyboard.up(key);
await page.waitForTimeout(600);
s = await st();
check('walking into a doorway changes room', s.room !== room0, `room ${room0} -> ${s.room}`);
await page.waitForTimeout(1500);
await page.screenshot({ path: 'tools/shots/in_room2.png' });

// --- restart from the pause menu, twice, then back to the main menu and start again
for (let i = 0; i < 2; i++) {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.mouse.move(960, 484);
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(1500);
  s = await st();
  check(`restart #${i + 1} gives a fresh run`, s.active.includes('Game') && s.shots === 0 && s.paused === false && s.time < 2, JSON.stringify({ shots: s.shots, t: s.time }));
}
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.mouse.move(960, 568);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(1500);
s = await st();
check('MAIN MENU returns to the menu', s.active.length === 1 && s.active[0] === 'Menu', JSON.stringify(s.active));
await page.keyboard.press('Enter');
await page.waitForTimeout(1800);
s = await st();
check('ENTER starts a run from the menu', s.active.includes('Game') && s.active.includes('UI'), JSON.stringify(s.active));
await page.keyboard.down('d');
await page.waitForTimeout(300);
await page.keyboard.up('d');
const again = await st();
check('controls still work after returning from the menu', again.x > 0 && again.time > 0.2);

// --- death and retry through the real UI
await page.evaluate(() => {
  const s = window.__golibaaz;
  s.player.hp = 1;
  s.player.invuln = 0;
  s.player.hurt(0);
});
await page.waitForTimeout(3000);
s = await st();
check('dying ends the run', s.over === true);
await page.mouse.move(750, 860);
await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(1600);
s = await st();
check('TRY AGAIN starts a fresh run', s.over === false && s.hp === 6 && s.time < 2, JSON.stringify({ hp: s.hp, t: s.time }));

console.log(errors.length ? `CONSOLE ERRORS:\n${[...new Set(errors)].join('\n')}` : 'no console errors');
console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL INPUT CHECKS PASSED');
await browser.close();
process.exit(failed || errors.length ? 1 : 0);
