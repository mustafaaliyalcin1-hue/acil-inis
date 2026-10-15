// Persistent settings, scores and cargo career in localStorage (+ export/import).
const KEY = 'acilinis.save.v1';

export type Quality = 'auto' | 'low' | 'med' | 'high';
export interface Settings {
  quality: Quality;
  control: 'joystick' | 'tilt';
  tiltSens: number;
  stickSens: number;
  invertPitch: boolean;
  difficulty: 'real' | 'easy' | 'hard';
  volume: number;
  voice: boolean;
  units: 'aviation';
  hudScale: number;
  tiltCal: { beta: number; gamma: number } | null;
  worldMode: 'offline' | 'online';
  googleKey: string;
  showGlideRing: boolean;
  tutorialDone: boolean;
  buildings: boolean;
}
export interface ScoreEntry { id: string; stars: number; saved: number; total: number; vs: number; site: string; at: number; aircraft: string }
export interface OwnedPlane { id: string; type: string; condition: number; fuelKg: number; at: string; hours: number }
export interface Career { money: number; location: string; planes: OwnedPlane[]; active: string; deliveries: number; earned: number; contracts: any[]; contractsAt: number; seed: number }
export interface SaveData { v: 1; settings: Settings; scores: Record<string, ScoreEntry>; career: Career | null; flights: number }

export const defaultSettings = (): Settings => ({
  quality: 'auto', control: 'joystick', tiltSens: 1, stickSens: 1, invertPitch: false, difficulty: 'real',
  volume: 0.8, voice: true, units: 'aviation', hudScale: 1, tiltCal: null, worldMode: 'offline', googleKey: '',
  showGlideRing: true, tutorialDone: false, buildings: true
});

let data: SaveData = load();

function load(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      if (d && d.v === 1) return { ...d, settings: { ...defaultSettings(), ...d.settings } };
    }
  } catch { /* storage unavailable */ }
  return { v: 1, settings: defaultSettings(), scores: {}, career: null, flights: 0 };
}

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* quota / private mode */ }
}
export const store = {
  get data() { return data; },
  get settings() { return data.settings; },
  set<K extends keyof Settings>(k: K, v: Settings[K]) { data.settings[k] = v; save(); },
  score(id: string, e: ScoreEntry) {
    const old = data.scores[id];
    if (!old || e.stars > old.stars || (e.stars === old.stars && e.saved > old.saved)) data.scores[id] = e;
    data.flights++; save();
  },
  exportJSON() { return JSON.stringify(data, null, 1); },
  importJSON(txt: string) {
    const d = JSON.parse(txt);
    if (!d || d.v !== 1 || !d.settings) throw new Error('Geçersiz kayıt dosyası');
    data = { ...d, settings: { ...defaultSettings(), ...d.settings } };
    save();
  },
  reset() { data = { v: 1, settings: defaultSettings(), scores: {}, career: null, flights: 0 }; save(); }
};
