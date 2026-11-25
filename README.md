# GOLIBAAZ

A top-down action roguelike: dodge-roll through bullet patterns, clear procedurally generated rooms, beat three bosses.

Built with Phaser 3, TypeScript and Vite. Every sprite, sound and music track is generated in code at runtime, so there are no asset files.

## Run it

```
npm install
npm run dev
```

Then open http://localhost:5173. `npm run build` produces a static site in `dist/` that can be hosted anywhere (Vercel, itch.io, GitHub Pages).

## Controls

| Input | Action |
| --- | --- |
| W A S D | Move |
| Mouse | Aim |
| Left click | Shoot (hold to keep firing) |
| Space / Shift / Right click | Dodge roll (you cannot be hit while rolling) |
| R | Reload. Tap R again in the gold zone for a perfect reload (+25% damage for that magazine) |
| Q / F | Blast: wipes every enemy bullet and shoves enemies back |
| E | Interact: chests, shop, pickups, stairs |
| 1-4 / Mouse wheel | Switch weapon |
| Esc / P | Pause |

## Versus (online 1v1)

Pick **VERSUS** on the menu, then **CREATE ROOM** and send the 4-letter code to a friend, who picks **JOIN ROOM** and enters it. First to 3 round wins. Everyone gets the same four guns each round (Sidearm, Carbine, Pump Shotgun, Peacemaker); Esc leaves the match.

Every browser simulates only its own player and reports its position and shots, so damage is always decided on the machine of whoever got hit. A small relay (`server/relay.mjs`) pairs the two players and forwards messages; `npm run dev` and `npm run preview` already serve it at `/ws`, so both players just open the same address (for example `http://<your-ip>:5173`). To host the game as a static site, run the relay separately (`npm run relay`, default port 8787) and build with `VITE_RELAY_URL=wss://your-relay-host/ws`.

## Mobile

Phones and tablets get twin-stick touch controls automatically (the game switches at the first touch). Play in landscape; holding the phone upright pauses the run and asks you to turn it.

| Touch | Action |
| --- | --- |
| Left thumb, anywhere on the left half | Move (the stick appears where you touch) |
| Right thumb, anywhere on the right half | Aim; push past the inner ring to shoot. A light aim assist helps |
| ROLL / RELOAD / BLAST buttons | As on desktop. Tap RELOAD again in the gold zone for a perfect reload |
| Gold button that appears by an item | Interact: open, buy, pick up, descend |
| Weapon panel | Tap to switch weapon |
| Pause button, top right | Pause |

To install it like an app: on Android open the page in Chrome and choose **Add to Home screen** (or **Install app**); on iPhone open it in Safari, tap Share, then **Add to Home Screen**. Started from the home screen it runs without browser bars, and Android also locks it to landscape. In an Android browser tab, START RUN switches to fullscreen (toggle it in OPTIONS).

iPhone Safari has no fullscreen for web pages and cannot lock the orientation, so in a normal tab the browser bars stay visible and the turn-your-phone card appears when held upright; adding it to the home screen removes the bars. Sound starts after your first tap.

Add `?touch=1` to the URL to force touch mode on a desktop browser (for testing with the browser's device emulation) or `?touch=0` to turn it off.

## The game

- **Three floors** (Cellars, Foundry, Sanctum), each a random map of combat rooms plus one treasure room, one shop and a boss.
- **Combat rooms** lock when you enter and send two or three waves. Spawn markers appear before enemies do.
- **9 enemy types**, each with a telegraphed attack: riflemen, shotgunners, swarmers, chargers, snipers, grenadiers, turrets, shielded heavies and bouncing drones. Elites appear from floor 2.
- **3 bosses** with scripted attack patterns that get harder as their health drops.
- **11 weapons** and **22 stackable upgrades**. Treasure rooms give a weapon and a choice of two upgrades, bosses give a choice of three, shops sell both.
- **Recoil** pushes you backwards when you fire; heavy guns can be used to move.
- **Combo**: quick kills build a multiplier for score and coin drops.
- After the final boss you can descend again into a harder loop with everything you carry.

## Project layout

```
src/
  main.ts              boot, font loading, Phaser config
  config.ts            sizes, render depths, floor themes
  core/                math, seeded RNG, save data, synthesized audio, test bot
  gfx/                 procedural textures, particles, lighting, screen shake
  world/               floor layout, room layout, enemy waves, live room (collision, pathing, baked art)
  entities/            player, weapons, upgrades, bullets, enemies, bosses, pickups
  scenes/              Boot, Menu, Game (the run), UI (HUD and overlays)
tools/                 automated tests (see below)
```

Balance numbers live in three data files: `entities/weapons.ts`, `entities/enemyDefs.ts` and `entities/upgrades.ts`. Boss patterns are generator scripts at the bottom of `entities/boss.ts`.

## Testing

The dev server must be running for the browser tests. They use your installed Chrome through `playwright-core`.

| Command | What it checks |
| --- | --- |
| `npm run typecheck` | TypeScript |
| `npm run test:gen` | 21,000+ generated rooms: every floor has all room types, doors line up, every room is fully walkable |
| `node tools/inputtest.mjs` | Real mouse and keyboard events: menu, move, aim, shoot, roll, reload, perfect reload, blast, pause, weapon switch, doors, restart, death and retry |
| `node tools/touchtest.mjs` (`npm run test:touch`) | Real multi-touch on a phone-sized screen (844x390): touch detection, menu, both sticks, roll while moving and aiming, reload and perfect reload, blast, interact, weapon tap, pause, reward cards, portrait overlay, boss camera, death and retry |
| `node tools/playtest.mjs <seed> <speed> <god 1/0> [maxSec] [query]` | A bot plays a whole run and the script fails on any console error or stall. Pass `300 touch=1` to run it in touch mode |
| `node tools/shot.mjs "<query>" <name> <waitMs>` | Screenshot of any state into `tools/shots/` |

Useful URL parameters for debugging: `?play=1` skips the menu, `&bot=1` lets the bot play, `&god=1` disables damage, `&speed=4` runs the simulation faster, `&seed=7` fixes the run, `&floor=2` starts on a later floor, `&room=boss` (or `shop`, `treasure`) starts in that room, `&weapons=shotgun,sniper` adds guns.
