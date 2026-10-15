import './styles.css';
import * as THREE from 'three';
import { registerSW } from 'virtual:pwa-register';
import { Game, Session, FlightResult } from './game/game';
import { Screens } from './ui/screens';
import { AdminPanel } from './ui/admin';
import { pack } from './world/pack';
import { store } from './core/store';
import { audio } from './audio/audio';
import { FT } from './core/geo';

// --- iOS: no zoom / pinch / double-tap / pull-to-refresh
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false } as any);
document.addEventListener('touchmove', e => { if (!(e.target as HTMLElement).closest('.scr-body, .admin')) e.preventDefault(); }, { passive: false });
let lastTouch = 0;
document.addEventListener('touchend', e => { const n = Date.now(); if (n - lastTouch < 300) e.preventDefault(); lastTouch = n; }, { passive: false });
document.addEventListener('contextmenu', e => e.preventDefault());
try { (screen.orientation as any)?.lock?.('landscape').catch(() => {}); } catch { /* not supported on iOS */ }

const updateSW = registerSW({ immediate: true, onOfflineReady() { (window as any).__swReady = true; } });
void updateSW;

async function boot() {
  const bootEl = document.getElementById('boot')!;
  const sub = bootEl.querySelector('.boot-sub')!;
  try { await navigator.storage?.persist?.(); } catch { /* */ }
  sub.textContent = 'Offline paket kontrol ediliyor…';
  await pack.init();
  if (!pack.ready && store.settings.worldMode === 'offline' && navigator.onLine) {
    // no pack yet: run online until downloaded
  }
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const hudHost = document.getElementById('hud')!;
  const game = new Game(canvas, hudHost);
  sub.textContent = 'Dünya hazırlanıyor…';
  const mode = store.settings.worldMode === 'online' || !pack.ready ? (navigator.onLine && !pack.ready ? 'online' : store.settings.worldMode) : 'offline';
  await game.initWorld(mode as 'offline' | 'online');
  const screens = new Screens(game, s => start(s));
  let lastSession: Omit<Session, 'onEnd' | 'onExit'> | null = null;

  const teleport = async (aptId: string, onRunway: boolean) => {
    if (!lastSession) return;
    const ac = game.ac; const fuel = ac?.fuel, payload = ac?.payload, type = lastSession.type;
    await start({ ...lastSession, type, fuelKg: fuel, payloadKg: payload, start: onRunway ? { kind: 'runway', apt: aptId, end: 0 } : { kind: 'final', apt: aptId, end: 0, distKm: 10, aglFt: 1750, kt: Math.round(type.vr * 1.12) } }, true);
  };
  const admin = new AdminPanel(document.getElementById('ui')!, game, teleport);

  async function start(s: Omit<Session, 'onEnd' | 'onExit'>, keep = false) {
    audio.init();
    screens.close();
    if (!keep) lastSession = s;
    bootEl.style.display = 'flex'; bootEl.style.opacity = '1'; sub.textContent = 'Uçuş hazırlanıyor…';
    const want = store.settings.worldMode === 'online' && navigator.onLine ? 'online' : pack.ready ? 'offline' : 'online';
    await game.initWorld(want);
    if (want === 'online') {
      const a = game.world.db.byId.get(s.start.apt);
      if (a) await game.world.rebase(a.lat, a.lon);
    }
    await game.start({ ...s, onEnd: r => results(r), onExit: () => toMenu() });
    if (s.mode === 'free') admin.show(); else admin.hide();
    bootEl.style.opacity = '0'; setTimeout(() => bootEl.style.display = 'none', 500);
  }
  function results(r: FlightResult) {
    admin.hide();
    game.setHudVisible(false);
    screens.results(r, () => replay(), () => lastSession && start(lastSession), () => { if (r.session.mode === 'cargo') { game.endFlight(); screens.cargo(); } else toMenu(); });
  }
  function toMenu() { admin.hide(); game.endFlight(); screens.main(); }
  game.onPause = () => {
    game.paused = true;
    screens.pause(() => { game.paused = false; }, () => lastSession && start(lastSession), () => { game.paused = false; toMenu(); });
  };

  // cinematic replay of the recorded flight
  function replay() {
    const rec = game.replay; const m = (game as any).model as { root: THREE.Object3D } | null;
    if (!rec.length || !m) return toMenu();
    game.setHudVisible(false);
    const ac = game.ac!; ac.frozen = true;
    let i = 0, t = rec[0].t;
    const speedSel = document.createElement('div');
    speedSel.className = 'topbar';
    speedSel.innerHTML = `<button class="hbtn ia" data-s="0.5">0.5×</button><button class="hbtn ia on" data-s="1">1×</button><button class="hbtn ia" data-s="2">2×</button><button class="hbtn ia" data-s="x">✕ Bitir</button>`;
    document.getElementById('ui')!.appendChild(speedSel);
    let spd = 1, done = false;
    speedSel.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.onclick = () => {
      if (b.dataset.s === 'x') { done = true; return; }
      spd = +b.dataset.s!; speedSel.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
    const cams: ('chase' | 'tower' | 'wing' | 'orbit')[] = ['chase', 'tower', 'wing', 'tower', 'orbit'];
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      t += dt * spd;
      while (i < rec.length - 2 && rec[i + 1].t < t) i++;
      const a = rec[i], b = rec[Math.min(rec.length - 1, i + 1)];
      const k = b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 0;
      ac.pos.set(a.p[0] + (b.p[0] - a.p[0]) * k, a.p[1] + (b.p[1] - a.p[1]) * k, a.p[2] + (b.p[2] - a.p[2]) * k);
      ac.q.set(a.q[0], a.q[1], a.q[2], a.q[3]).slerp(new THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]), k);
      ac.gearPos = a.g; ac.flapPos = a.f;
      m.root.position.copy(ac.pos); m.root.quaternion.copy(ac.q);
      // auto camera: change every ~6 s, tower near the ground
      const seg = Math.floor(t / 6) % cams.length;
      game.camMode = ac.pos.y - game.world.ground(ac.pos.x, ac.pos.z).h < 400 * FT ? (seg % 2 ? 'tower' : 'chase') : cams[seg];
      if (!done && i < rec.length - 2) requestAnimationFrame(step);
      else { speedSel.remove(); ac.frozen = false; toMenu(); }
    };
    requestAnimationFrame(step);
  }

  bootEl.style.opacity = '0'; setTimeout(() => bootEl.style.display = 'none', 500);
  screens.main();
  game.backdrop(pack.ready || mode === 'online' ? 'LTBA' : 'LTBA');
  (window as any).__game = game;
  (window as any).__start = start;
  (window as any).__screens = screens;
}

boot().catch(e => {
  console.error(e);
  const sub = document.querySelector('.boot-sub');
  if (sub) sub.textContent = 'Başlatma hatası: ' + (e?.message ?? e);
});
