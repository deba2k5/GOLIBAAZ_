const KEY = 'golibaaz.save.v1';
/** Saves from before the game was renamed are picked up once and moved over. */
const OLD_KEY = 'recoil.save.v1';

export interface SaveData {
  bestScore: number;
  bestFloor: number;
  runs: number;
  wins: number;
  sfxVol: number;
  musicVol: number;
  shake: number;
  seenHelp: boolean;
}

const DEFAULTS: SaveData = {
  bestScore: 0,
  bestFloor: 0,
  runs: 0,
  wins: 0,
  sfxVol: 0.8,
  musicVol: 0.5,
  shake: 1,
  seenHelp: false,
};

let cache: SaveData | null = null;

export function loadSave(): SaveData {
  if (cache) return cache;
  let data: Partial<SaveData> = {};
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
    if (raw) data = JSON.parse(raw);
  } catch {
    data = {};
  }
  cache = { ...DEFAULTS, ...data };
  return cache;
}

export function writeSave(patch: Partial<SaveData>): SaveData {
  const s = { ...loadSave(), ...patch };
  cache = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage can be unavailable (private mode); the game still runs.
  }
  return s;
}
