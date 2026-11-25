import '@fontsource/oswald/latin-400.css';
import '@fontsource/oswald/latin-500.css';
import '@fontsource/oswald/latin-700.css';
import Phaser from 'phaser';
import { GH, GW } from './config';
import { audio } from './core/audio';
import { isTouch, onTouchChange } from './core/device';
import { BootScene } from './scenes/BootScene';
import { GameScene } from './scenes/GameScene';
import { MenuScene } from './scenes/MenuScene';
import { UIScene } from './scenes/UIScene';
import { AvatarScene } from './versus/AvatarScene';
import { BetScene } from './versus/BetScene';
import { LobbyScene } from './versus/LobbyScene';
import { VsHud } from './versus/VsHud';
import { mountWallet } from './web3/mount';

/** Stop the page itself from zooming, scrolling or bouncing under the player's thumbs. */
function lockPage(): void {
  const stop = (e: Event) => {
    if (e.cancelable) e.preventDefault();
  };
  // iOS Safari ignores user-scalable=no; these are its pinch-zoom events
  document.addEventListener('gesturestart', stop, { passive: false });
  document.addEventListener('gesturechange', stop, { passive: false });
  // no page scroll / pull-to-refresh / pinch from the letterbox bars or overlays
  document.addEventListener('touchmove', stop, { passive: false });
  document.addEventListener('dblclick', stop, { passive: false });
  document.addEventListener('selectstart', stop);
}

/** Cover the game with a "turn your phone" card while a touch device is held upright. */
function rotateGuard(game: Phaser.Game): void {
  const el = document.getElementById('rotate');
  if (!el) return;
  const portrait = window.matchMedia('(orientation: portrait)');
  let shown = false;
  const update = () => {
    document.documentElement.classList.toggle('touch', isTouch());
    const show = isTouch() && portrait.matches;
    if (show === shown) return;
    shown = show;
    el.hidden = !show;
    // GameScene pauses the run on the game's blur event (the menu ignores it).
    // focus does not resume: the player taps RESUME when ready.
    game.events.emit(show ? 'blur' : 'focus');
  };
  if (portrait.addEventListener) portrait.addEventListener('change', update);
  else portrait.addListener(update);
  window.addEventListener('resize', update);
  onTouchChange(update);
  update();
}

/**
 * On a phone wider than 16:9 the canvas is letterboxed and thumbs often land on the black bars.
 * Phaser already hears touchstart / touchend anywhere on the page (window listeners), but it only
 * tracks touchmove on the canvas and only while the finger is over it, so a stick dragged from a
 * bar (or slid off the canvas onto one) would stop tracking. Update those pointers here and leave
 * the rest to Phaser. The touch controls read pointer positions every frame.
 */
function forwardLetterboxTouches(game: Phaser.Game): void {
  type MovablePointer = Phaser.Input.Pointer & { touchmove?: (t: Touch, e: TouchEvent) => void };
  document.addEventListener('touchmove', (e) => {
    const r = game.canvas.getBoundingClientRect();
    for (const t of Array.from(e.changedTouches)) {
      const inside = t.clientX >= r.left && t.clientX < r.right && t.clientY >= r.top && t.clientY < r.bottom;
      if (e.target === game.canvas && inside) continue; // Phaser handles this one
      const p = game.input.pointers.find((q) => q.active && q.identifier === t.identifier) as MovablePointer | undefined;
      p?.touchmove?.(t, e);
    }
  }, { passive: true });
}

/**
 * Phaser refits the canvas straight away on an orientation change, which can run before the page
 * has its new size and leave the canvas fitted to the old shape (seen turning portrait -> landscape:
 * a tiny canvas in the middle of the screen). Refit again once the rotation has settled.
 */
function refitAfterRotate(game: Phaser.Game): void {
  let timers: number[] = [];
  const refit = () => {
    game.scale.getParentBounds();
    game.scale.refresh();
  };
  const schedule = () => {
    for (const t of timers) clearTimeout(t);
    timers = [150, 600].map((ms) => window.setTimeout(refit, ms));
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  screen.orientation?.addEventListener?.('change', schedule);
}

async function boot(): Promise<void> {
  lockPage();
  // Canvas text needs the web font to be ready before the first Text object is drawn.
  try {
    await Promise.all([
      document.fonts.load('400 32px Oswald'),
      document.fonts.load('500 32px Oswald'),
      document.fonts.load('700 32px Oswald'),
    ]);
  } catch {
    // fall back to system fonts
  }

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game',
    width: GW,
    height: GH,
    backgroundColor: '#08070a',
    scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    render: { antialias: true, powerPreference: 'high-performance' },
    // two thumbs at once on phones (move + aim), plus a spare for the action buttons
    input: { activePointers: 4 },
    disableContextMenu: true,
    scene: [BootScene, MenuScene, BetScene, AvatarScene, LobbyScene, GameScene, UIScene, VsHud],
  });

  // Browsers only allow audio after a user gesture. On touch screens only the touchend /
  // pointerup counts as one (touchstart does not), so listen for the release as well.
  const unlock = () => audio.unlock();
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('pointerup', unlock);
  window.addEventListener('touchend', unlock);
  window.addEventListener('keydown', unlock);
  rotateGuard(game);
  forwardLetterboxTouches(game);
  refitAfterRotate(game);
  (window as unknown as { __game: Phaser.Game }).__game = game;
}

mountWallet();
void boot();
