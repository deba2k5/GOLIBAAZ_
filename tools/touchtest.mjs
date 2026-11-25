// Drives the game with real multi-touch events on a phone-sized screen (no bot) and asserts that
// every touch control works. usage: node tools/touchtest.mjs   (dev server on PORT, default 5173)
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const port = process.env.PORT ?? '5173';
const GW = 1920;
const GH = 1080;
fs.mkdirSync('tools/shots', { recursive: true });
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
// a landscape phone: 844 x 390 CSS px (iPhone 12-15 class), touch only
const context = await browser.newContext({
  viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`${e.message}\n${(e.stack ?? '').split('\n').slice(0, 5).join('\n')}`));

let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};
const wait = (ms) => page.waitForTimeout(ms);
const shot = (name) => page.screenshot({ path: `tools/shots/${name}.png` });

// ---------------------------------------------------------------- touch helpers (logical 1920x1080 coords)
let rect = null;
const updateRect = async () => {
  rect = await page.evaluate(() => {
    const r = document.querySelector('canvas').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
};
const toPage = (lx, ly) => ({ x: rect.x + (lx / GW) * rect.w, y: rect.y + (ly / GH) * rect.h });
/** id -> page point of every finger currently down */
const fingers = new Map();
const points = () => [...fingers].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 8, radiusY: 8, force: 1 }));
const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
/** Put a finger down at a logical point (or at a raw page point with { page: true }). */
async function down(id, x, y, o = {}) {
  fingers.set(id, o.page ? { x, y } : toPage(x, y));
  await send('touchStart', points());
}
/** Slide a finger to a logical point in a few steps. */
async function move(id, x, y, steps = 5) {
  const from = fingers.get(id);
  const to = toPage(x, y);
  for (let i = 1; i <= steps; i++) {
    fingers.set(id, { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });
    await send('touchMove', points());
    await wait(16);
  }
}
/** Slide by a logical offset. */
async function moveBy(id, dx, dy, steps = 5) {
  const p = fingers.get(id);
  const lx = ((p.x - rect.x) / rect.w) * GW;
  const ly = ((p.y - rect.y) / rect.h) * GH;
  await move(id, lx + dx, ly + dy, steps);
}
/** Lift one finger: CDP touchEnd lists only the point being lifted. */
async function up(id) {
  const p = fingers.get(id);
  fingers.delete(id);
  await send('touchEnd', [{ x: p.x, y: p.y, id }]);
}
async function tap(x, y, id = 9) {
  await down(id, x, y);
  await wait(60);
  await up(id);
}

const st = () => page.evaluate(() => {
  const s = window.__golibaaz;
  const g = window.__game;
  const active = g.scene.getScenes(true).map((x) => x.scene.key);
  const ui = g.scene.getScene('UI');
  if (!s || !s.run || !s.player || !active.includes('Game')) return { active };
  const p = s.player;
  return {
    active, x: p.x, y: p.y, aim: p.aim, shots: s.run.shots, rolls: s.run.rolls, clip: p.weapon.clip, reloading: p.reloading,
    paused: s.paused, modal: s.modal, blanks: p.blanks, time: s.run.time, weapon: p.weapon.def.id, perfects: s.run.perfects,
    hp: p.hp, over: s.run.over, ups: Object.keys(s.run.upgrades).length, zoom: s.cameras.main.zoom,
    fire: s.touch.fire, mx: s.touch.mx, my: s.touch.my, uiTouch: ui && ui.touch, controls: ui && ui.controls && ui.controls.enabled,
    overlay: !!(ui && ui.overlay), bossShown: !!(ui && ui.bossShown), interact: !!s.interactTarget,
    interactBtn: !!(ui && ui.controls.btns.find((b) => b.id === 'interact').g.visible),
  };
});
const angNear = (a, b, tol) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < tol;
/** Wait until a reload in progress has finished. */
const settle = async () => {
  for (let i = 0; i < 30 && (await st()).reloading; i++) await wait(100);
};

// fixed touch controls, mirrored from TOUCH_LAYOUT in src/scenes/touchControls.ts
const BTN = {
  roll: { x: GW - 190, y: GH - 200 },
  reload: { x: GW - 450, y: GH - 120 },
  blast: { x: GW - 130, y: GH - 450 },
  interact: { x: GW - 470, y: GH - 360 },
  pause: { x: GW - 100, y: 96 },
  weapon: { x: GW / 2, y: GH - 112 },
};
const MOVE = { x: 360, y: 760 };
const AIM = { x: 1260, y: 700 };

// ================================================================ menu
await page.goto(`http://localhost:${port}/`);
await wait(2800);
await updateRect();
let menu = await page.evaluate(() => ({
  menuTouch: window.__game.scene.getScene('Menu').touch,
  htmlTouch: document.documentElement.classList.contains('touch'),
  url: location.search,
}));
check('touch mode is detected without the ?touch=1 flag', menu.menuTouch === true && menu.htmlTouch && !menu.url.includes('touch'), JSON.stringify(menu));
check('canvas is letterboxed inside the phone screen', rect.w <= 844 && rect.h <= 390 && rect.w > 600, JSON.stringify(rect));
await shot('touch_menu');
// the touch menu: START RUN is the big button at y 548 (desktop has it at 640)
await tap(GW / 2, 548);
await wait(1900);
let s = await st();
check('START RUN starts a run by tap', s.active.includes('Game') && s.active.includes('UI'), JSON.stringify(s.active));
check('HUD and controls are in touch mode', s.uiTouch === true && s.controls === true && Math.abs(s.zoom - 1.6) < 0.01, `zoom=${s.zoom}`);
await wait(2200); // let the floor banner clear
await shot('touch_start_room');

// ================================================================ move stick
let a = await st();
await down(1, MOVE.x, MOVE.y);
await move(1, MOVE.x + 150, MOVE.y);
await wait(400);
s = await st();
check('move stick: dragging right moves the player right', s.x > a.x + 60 && Math.abs(s.y - a.y) < 25, `dx=${Math.round(s.x - a.x)} dy=${Math.round(s.y - a.y)}`);
a = s;
await move(1, MOVE.x + 150, MOVE.y - 150);
await wait(350);
s = await st();
check('move stick: the base follows the thumb, dragging up moves up', s.y < a.y - 50, `dy=${Math.round(s.y - a.y)}`);
await up(1);
await wait(150);
a = await st();
await wait(250);
s = await st();
check('move stick: lifting the thumb stops the player', Math.hypot(s.x - a.x, s.y - a.y) < 12 && s.mx === 0 && s.my === 0);

// a thumb that lands on the black letterbox bar left of the canvas still drives the move stick
a = await st();
await down(2, Math.max(4, rect.x / 2), rect.y + rect.h * 0.7, { page: true });
await moveBy(2, 0, 150);
await wait(350);
s = await st();
check('move stick works from the letterbox bar beside the canvas', s.y > a.y + 40, `dy=${Math.round(s.y - a.y)} bar=${Math.round(rect.x)}px`);
await up(2);
await wait(200);

// ================================================================ aim stick
a = await st();
await down(3, AIM.x, AIM.y);
await move(3, AIM.x - 50, AIM.y); // past the dead zone, short of the fire threshold
await wait(200);
s = await st();
check('aim stick: a short drag aims without firing', angNear(s.aim, Math.PI, 0.3) && s.shots === a.shots, `aim=${s.aim.toFixed(2)} shots=${s.shots - a.shots}`);
await move(3, AIM.x, AIM.y - 150); // straight up, past the fire threshold
await wait(650);
s = await st();
await shot('touch_aim_fire');
check('aim stick: pushing further aims and fires while held', angNear(s.aim, -Math.PI / 2, 0.3) && s.shots - a.shots >= 3,
  `aim=${s.aim.toFixed(2)} shots=${s.shots - a.shots}`);
await up(3);
await wait(120);
a = await st();
await wait(350);
s = await st();
check('aim stick: releasing stops firing', s.shots === a.shots && !s.fire, `shots=${s.shots - a.shots}`);
check('aim stick: the aim direction persists after release', angNear(s.aim, -Math.PI / 2, 0.3), `aim=${s.aim.toFixed(2)}`);

// ================================================================ move + aim + roll at the same time
await settle();
await wait(500);
a = await st();
await down(1, MOVE.x, MOVE.y);
await move(1, MOVE.x - 150, MOVE.y); // move left
await down(3, AIM.x, AIM.y);
await move(3, AIM.x + 150, AIM.y); // aim and fire right
await wait(250);
await tap(BTN.roll.x, BTN.roll.y, 5);
await wait(450);
s = await st();
check('move + aim + ROLL together: rolls while aiming and firing', s.rolls === a.rolls + 1 && s.shots > a.shots && angNear(s.aim, 0, 0.35),
  `rolls=${s.rolls - a.rolls} shots=${s.shots - a.shots} aim=${s.aim.toFixed(2)}`);
check('ROLL goes in the move direction (left, while aiming right)', s.x < a.x - 100, `dx=${Math.round(s.x - a.x)}`);
await up(3);
await up(1);
await wait(400);
a = await st();
await down(1, MOVE.x, MOVE.y);
await move(1, MOVE.x, MOVE.y + 150); // down
await tap(BTN.roll.x, BTN.roll.y, 5);
await wait(450);
await up(1);
s = await st();
check('ROLL goes in the move direction (down)', s.rolls === a.rolls + 1 && s.y > a.y + 90, `dy=${Math.round(s.y - a.y)}`);

// ================================================================ reload / perfect reload
await settle();
a = await st();
if (a.clip >= 10) {
  // fire a couple of shots so there is something to reload
  await down(3, AIM.x, AIM.y);
  await move(3, AIM.x, AIM.y - 150);
  await wait(250);
  await up(3);
  await wait(150);
}
await tap(BTN.reload.x, BTN.reload.y, 6);
await wait(100);
s = await st();
check('RELOAD starts a reload', s.reloading === true, `clip=${s.clip}`);
// the perfect window is 36%-54% of the reload: wait in the page until it is 42% done, then tap
await page.evaluate(() => new Promise((res) => {
  const p = window.__golibaaz.player;
  const tick = () => (!p.reloading || p.reloadT / p.reloadDur >= 0.42 ? res() : requestAnimationFrame(tick));
  tick();
}));
await tap(BTN.reload.x, BTN.reload.y, 6);
await wait(150);
s = await st();
check('second RELOAD tap in the gold window gives a perfect reload', s.perfects === a.perfects + 1 && !s.reloading && s.clip === 10,
  `perfects=${s.perfects - a.perfects} clip=${s.clip}`);
// a screenshot of the reload ring on the RELOAD button
await down(3, AIM.x, AIM.y);
await move(3, AIM.x, AIM.y - 150);
await wait(250);
await up(3);
await tap(BTN.reload.x, BTN.reload.y, 6);
await wait(380);
await shot('touch_reload');
await settle();

// ================================================================ blast
a = await st();
await tap(BTN.blast.x, BTN.blast.y, 6);
await wait(250);
s = await st();
check('BLAST uses a charge', s.blanks === a.blanks - 1, `${a.blanks} -> ${s.blanks}`);

// ================================================================ interact + weapon cycle
s = await st();
check('INTERACT button is hidden with nothing nearby', !s.interactBtn);
await page.evaluate(() => {
  const g = window.__golibaaz;
  g.pickups.spawn('weapon', g.player.x, g.player.y, { weapon: 'shotgun' });
});
await wait(400);
s = await st();
check('INTERACT button appears next to a pickup', s.interact && s.interactBtn);
await shot('touch_interact');
await tap(BTN.interact.x, BTN.interact.y, 6);
await wait(350);
s = await st();
check('INTERACT picks the weapon up', s.weapon === 'shotgun' && !s.interactBtn, s.weapon);
await tap(BTN.weapon.x, BTN.weapon.y, 6);
await wait(250);
s = await st();
check('tapping the weapon panel cycles weapons', s.weapon === 'pistol', s.weapon);
await tap(BTN.weapon.x, BTN.weapon.y, 6);
await wait(250);
s = await st();
check('tapping it again cycles back', s.weapon === 'shotgun', s.weapon);

// ================================================================ pause / resume
await tap(BTN.pause.x, BTN.pause.y, 6);
await wait(350);
s = await st();
check('PAUSE button pauses', s.paused === true);
await shot('touch_pause');
const t0 = s.time;
await wait(400);
s = await st();
check('time stands still while paused', s.time === t0);
a = s;
// the touch pause menu has RESUME at (GW/2 - 540, 285)
await tap(GW / 2 - 540, 285, 6);
await wait(450);
s = await st();
check('RESUME by tap resumes', s.paused === false && s.time > t0);
check('the RESUME tap does not fire a shot or grab a stick', s.shots === a.shots && !s.fire && s.mx === 0 && s.my === 0, `shots=${s.shots - a.shots}`);
// a finger that went down while the menu was up is not a stick after the menu closes
await tap(BTN.pause.x, BTN.pause.y, 6);
await wait(300);
a = await st();
await down(3, AIM.x, AIM.y);
await move(3, AIM.x, AIM.y - 150);
await tap(GW / 2 - 540, 285, 6);
await wait(150);
await moveBy(3, 0, -20);
await wait(300);
s = await st();
check('a touch held through RESUME does not start firing', s.paused === false && s.shots === a.shots && !s.fire, `shots=${s.shots - a.shots}`);
await up(3);

// ================================================================ reward cards
a = await st();
await page.evaluate(() => window.__golibaaz.offerBossReward());
await wait(900);
s = await st();
check('reward cards are up', s.modal && s.overlay);
await shot('touch_reward');
// three cards: 540 wide, 40 apart, centred at y 615 -> first card centre x = GW/2 - 580
await tap(GW / 2 - 580, 615, 6);
await wait(400);
s = await st();
check('tapping a reward card takes that upgrade', !s.modal && !s.overlay && s.ups === a.ups + 1, `ups ${a.ups} -> ${s.ups}`);
check('the card tap does not fire a shot', s.shots === a.shots);

// ================================================================ portrait guard
await page.setViewportSize({ width: 390, height: 844 });
await wait(500);
let rot = await page.evaluate(() => !document.getElementById('rotate').hidden);
s = await st();
check('portrait shows the turn-your-phone overlay and pauses', rot && s.paused === true);
await shot('touch_portrait');
await page.setViewportSize({ width: 844, height: 390 });
await wait(900);
await updateRect();
rot = await page.evaluate(() => !document.getElementById('rotate').hidden);
check('landscape hides the overlay (the run stays paused until RESUME)', !rot && (await st()).paused === true);
check('the canvas refits to the full landscape screen after rotating back', Math.abs(rect.h - 390) < 2 && rect.w > 680, JSON.stringify(rect));
await tap(GW / 2 - 540, 285, 6);
await wait(400);
check('RESUME after rotating back resumes', (await st()).paused === false);

// ================================================================ boss fight
await page.evaluate(() => {
  const g = window.__golibaaz;
  g.player.god = true;
  const boss = g.run.plan.rooms.find((r) => r.type === 'boss');
  g.enterRoom(boss.id, null);
});
await wait(600);
s = await st();
check('boss bar shows in a boss fight', s.bossShown === true);
await wait(2600);
s = await st();
check('touch camera eases out to the boss zoom', Math.abs(s.zoom - 1.3) < 0.02, `zoom=${s.zoom.toFixed(3)}`);
await down(3, AIM.x, AIM.y);
await move(3, AIM.x, AIM.y - 150);
await page.evaluate(() => { const g = window.__golibaaz; g.run.combo = 8; g.run.comboT = 3; });
await wait(700);
await shot('touch_boss');
await up(3);

// ================================================================ game over and retry
await page.evaluate(() => {
  const g = window.__golibaaz;
  g.player.god = false;
  g.player.hp = 1;
  g.player.invuln = 0;
  g.player.hurt(0);
});
await wait(3200);
s = await st();
check('dying ends the run', s.over === true && s.overlay);
await shot('touch_gameover');
// touch game-over buttons: TRY AGAIN at (GW/2 - 320, 955)
await tap(GW / 2 - 320, 955, 6);
await wait(1800);
s = await st();
check('TRY AGAIN by tap gives a fresh run', s.over === false && s.hp === 6 && s.time < 2 && s.shots === 0 && Math.abs(s.zoom - 1.6) < 0.01,
  JSON.stringify({ hp: s.hp, t: s.time, zoom: s.zoom }));
await down(1, MOVE.x, MOVE.y);
a = await st();
await move(1, MOVE.x + 150, MOVE.y);
await wait(300);
await up(1);
s = await st();
check('controls still work in the new run', s.x > a.x + 30);

// ================================================================ ?room=boss picks up the boss that started before the HUD
for (const t of ['1', '0']) {
  await page.goto(`http://localhost:${port}/?play=1&room=boss&god=1&touch=${t}`);
  await wait(2500);
  s = await st();
  check(`?room=boss shows the boss bar (touch=${t})`, s.bossShown === true);
}

console.log(errors.length ? `CONSOLE ERRORS:\n${[...new Set(errors)].join('\n')}` : 'no console errors');
check('no console errors', errors.length === 0);
console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL TOUCH CHECKS PASSED');
await browser.close();
process.exit(failed ? 1 : 0);
