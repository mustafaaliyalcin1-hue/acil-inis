// Game orchestrator: renderer, cameras, world, aircraft, controls, HUD, audio, warnings, modes, results.
import * as THREE from 'three';
import { World, disposeGroup } from '../world/world';
import { Weather, WeatherState, defaultWeather } from '../world/weather';
import { Aircraft } from '../sim/flight';
import { AircraftType, typeById } from '../sim/aircraftData';
import { buildModel, PlaneModel } from '../sim/model';
import { Particles, Debris } from '../sim/particles';
import { Controls } from '../ui/controls';
import { Hud } from '../ui/hud';
import { audio } from '../audio/audio';
import { store } from '../core/store';
import { FT, KT, DEG, clamp, destination, wrap180, atmosphere, lerp, NM, haversine } from '../core/geo';
import { lightUniforms, Airport } from '../world/airports';
import type { Scenario } from './scenarios';
import type { Contract } from './cargo';
import { env } from '../world/env';

export type Mode = 'free' | 'emergency' | 'cargo' | 'tutorial';
export interface Session {
  mode: Mode; type: AircraftType; weather: Partial<WeatherState>;
  start: { kind: 'runway'; apt: string; end: number } | { kind: 'final'; apt: string; end: number; distKm: number; aglFt: number; kt: number }
    | { kind: 'air'; apt: string; bearing: number; distKm: number; altFt: number; hdg?: number; kt: number; climb?: boolean };
  scenario?: Scenario; engineFail?: 'one' | 'all' | 'asym2' | 'none'; contract?: Contract; fuelKg?: number; payloadKg?: number;
  pax: number; onEnd: (r: FlightResult) => void; onExit: () => void;
}
export interface FlightResult {
  session: Session; outcome: 'landed' | 'ditched' | 'field' | 'fatal' | 'aborted'; saved: number; total: number; vsFpm: number; peakG: number;
  site: string; damage: string[]; stars: number; minutes: number; fuelUsed: number; atAirport?: Airport; reason?: string; condLoss: number;
}
type CamMode = 'cockpit' | 'chase' | 'wing' | 'tower' | 'orbit';
const CAM_NAMES: Record<CamMode, string> = { cockpit: 'Kokpit', chase: 'Takip', wing: 'Kanat', tower: 'Kule', orbit: 'Serbest' };

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 1, 0.4, 600000);
  world!: World;
  weather = new Weather();
  ac: Aircraft | null = null;
  model: PlaneModel | null = null;
  smoke: Particles; glow: Particles;
  debris: Debris[] = [];
  controls: Controls; hud: Hud;
  session: Session | null = null;
  overlay = document.createElement('div');
  camMode: CamMode = 'chase';
  timeScale = 1; paused = false;
  private orbit = { yaw: 0.6, pitch: 0.18, dist: 0, dragging: false, lx: 0, ly: 0 };
  private last = performance.now();
  private acc = 0;
  private running = false;
  private frameTimes: number[] = [];
  private pr = 1;
  private warnEl!: HTMLElement; private msgEl!: HTMLElement; private objEl!: HTMLElement; private fireEl!: HTMLElement; private fadeEl!: HTMLElement;
  private calloutsDone = new Set<number>();
  private startTime = 0; private flightTime = 0; private fuelStart = 0;
  private ended = false;
  private onWarnings: string[] = [];
  private msgTimer = 0;
  private towerPos = new THREE.Vector3();
  replay: { t: number; p: number[]; q: number[]; g: number; f: number }[] = [];
  private replayTimer = 0;
  private chasePos = new THREE.Vector3();
  private tutorialStep = 0;
  onAdminToggle: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, hudHost: HTMLElement) {
    const q = store.settings.quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q !== 'low', logarithmicDepthBuffer: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.pr = Math.min(devicePixelRatio || 1, q === 'low' ? 1.25 : q === 'high' ? 2 : 1.6);
    this.renderer.setPixelRatio(this.pr);
    this.scene.add(this.camera);
    this.smoke = new Particles(this.scene);
    this.glow = new Particles(this.scene, THREE.AdditiveBlending);
    this.overlay.className = 'hud-layer';
    hudHost.appendChild(this.overlay);
    this.hud = new Hud(hudHost);
    this.controls = new Controls(hudHost);
    this.controls.onKeyAction = a => { if (!this.ac) return; if (a === 'pause') this.onPause?.(); else this.overlay.querySelector<HTMLButtonElement>(`[data-a="${a}"]`)?.click(); };
    this.buildOverlay();
    this.setHudVisible(false);
    addEventListener('resize', () => this.resize());
    this.resize();
    // orbit drag on canvas
    canvas.addEventListener('pointerdown', e => { this.orbit.dragging = true; this.orbit.lx = e.clientX; this.orbit.ly = e.clientY; });
    addEventListener('pointerup', () => { this.orbit.dragging = false; });
    canvas.addEventListener('pointermove', e => {
      if (!this.orbit.dragging) return;
      this.orbit.yaw -= (e.clientX - this.orbit.lx) * 0.006; this.orbit.pitch = clamp(this.orbit.pitch + (e.clientY - this.orbit.ly) * 0.004, -0.6, 1.3);
      this.orbit.lx = e.clientX; this.orbit.ly = e.clientY;
    });
    canvas.addEventListener('wheel', e => { this.orbit.dist = clamp((this.orbit.dist || 1) * (e.deltaY > 0 ? 1.1 : 0.9), 0.4, 6); });
  }

  async initWorld(mode: 'offline' | 'online') {
    if (this.world && this.world.mode === mode) return;
    if (this.world) { this.world.dispose(); this.scene.remove(this.world.terrain.group, this.world.sky.mesh); }
    this.world = new World(this.scene, mode);
    await this.world.init();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const px = h * this.pr / (2 * Math.tan(this.camera.fov * DEG / 2));
    lightUniforms.uPx.value = px; this.smoke.uPx.value = px; this.glow.uPx.value = px;
    this.hud.layout();
  }

  // ------------------------------------------------------------------ overlay (top bar, warnings)
  private buildOverlay() {
    const o = this.overlay;
    o.innerHTML = `
      <div class="topbar">
        <button class="hbtn ia" data-a="pause">⏸</button>
        <button class="hbtn ia" data-a="cam">🎥 Takip</button>
        <button class="hbtn ia" data-a="hud">HUD</button>
        <button class="hbtn ia" data-a="slow">1×</button>
      </div>
      <div class="warnbox"></div>
      <div class="objective" style="display:none"></div>
      <div class="msg"></div>
      <div class="fireh" style="position:absolute;left:50%;top:calc(46px + var(--sat));transform:translateX(-50%);display:flex;gap:8px"></div>
      <div class="fade"></div>`;
    this.warnEl = o.querySelector('.warnbox')!; this.msgEl = o.querySelector('.msg')!; this.objEl = o.querySelector('.objective')!;
    this.fireEl = o.querySelector('.fireh')!; this.fadeEl = o.querySelector('.fade')!;
    o.querySelectorAll<HTMLButtonElement>('[data-a]').forEach(b => b.addEventListener('click', () => {
      const a = b.dataset.a;
      if (a === 'pause') this.onPause?.();
      if (a === 'cam') { const order: CamMode[] = ['chase', 'cockpit', 'wing', 'tower', 'orbit']; this.camMode = order[(order.indexOf(this.camMode) + 1) % order.length]; b.textContent = '🎥 ' + CAM_NAMES[this.camMode]; this.orbit.dist = 0; }
      if (a === 'hud') { const v = this.hud.root.style.display === 'none'; this.hud.setVisible(v); this.controls.setVisible(true); }
      if (a === 'slow') { if (this.session?.mode !== 'free') return; this.timeScale = this.timeScale === 1 ? 0.5 : this.timeScale === 0.5 ? 0.25 : 1; b.textContent = this.timeScale + '×'; }
    }));
  }
  onPause: (() => void) | null = null;
  setHudVisible(v: boolean) { this.overlay.style.display = v ? '' : 'none'; this.hud.setVisible(v); this.controls.setVisible(v); }
  message(t: string, sec = 4) { this.msgEl.textContent = t; this.msgTimer = sec; }
  objective(t: string | null) { this.objEl.style.display = t ? '' : 'none'; if (t) this.objEl.innerHTML = t; }

  // ------------------------------------------------------------------ start a flight
  async start(s: Session) {
    this.endFlight(true);
    this.session = s; this.ended = false;
    this.weather = new Weather({ ...defaultWeather(), ...s.weather });
    this.world.sky.hour = this.weather.s.hour; this.world.sky.visibility = this.weather.s.visibility; this.world.sky.cloud = this.weather.s.cloud;
    const t = s.type;
    const events = { emit: (type: string, data?: any) => this.onEvent(type, data) };
    const ac = new Aircraft(t, this.world, this.weather, events);
    ac.easy = store.settings.difficulty === 'easy';
    ac.fuel = s.fuelKg ?? t.fuelMax * 0.35;
    ac.payload = s.payloadKg ?? Math.min(t.payloadMax, s.pax * 95 + t.payloadMax * 0.15);
    this.ac = ac;
    this.model = buildModel(t);
    this.scene.add(this.model.root);
    this.controls.attach(ac);
    this.calloutsDone.clear();
    this.replay = []; this.debris = [];
    this.smoke.clear(); this.glow.clear();
    this.fadeEl.style.opacity = '0';
    this.timeScale = 1; this.paused = false;
    this.tutorialStep = 0;
    // position
    const apt = this.world.db.byId.get(s.start.apt)!;
    await this.world.ensureAirport(apt);
    const st = s.start;
    if (st.kind === 'runway') {
      const r = apt.runways[Math.floor(st.end / 2)] ?? apt.runways[0], e = st.end % 2 as 0 | 1;
      const thr = r.ends[e], sg = e === 0 ? 1 : -1;
      const x = thr.x + r.dirx * sg * (thr.disp + 30), z = thr.z + r.dirz * sg * (thr.disp + 30);
      ac.ctl.gearDown = true; ac.ctl.flapIdx = Math.min(t.flaps.length - 1, t.kind === 'jet' ? 1 : 1);
      ac.place(x, r.elev + t.gearH - 0.25, z, thr.hdg, 0, 0, true);
      ac.ctl.trim = t.fbw ? 0 : 0.12;
    } else if (st.kind === 'final') {
      const r = apt.runways[Math.floor(st.end / 2)] ?? apt.runways[0], e = st.end % 2 as 0 | 1;
      const thr = r.ends[e], sg = e === 0 ? 1 : -1;
      const d = st.distKm * 1000;
      const x = thr.x - r.dirx * sg * d, z = thr.z - r.dirz * sg * d;
      const y = r.elev + st.aglFt * FT;
      ac.ctl.gearDown = st.distKm < 12; ac.ctl.flapIdx = st.distKm < 12 ? t.flaps.length - 2 : 1;
      const tas = st.kt * KT / Math.sqrt(atmosphere(y).sigma);
      ac.place(x, y, z, thr.hdg, tas, 0, false);
    } else {
      const p = destination(apt.lat, apt.lon, st.bearing, st.distKm * 1000);
      const x = this.world.proj.x(p.lon), z = this.world.proj.z(p.lat);
      const y = st.altFt * FT;
      const hdg = st.hdg ?? ((Math.atan2(apt.x - x, -(apt.z - z)) / DEG + 360) % 360);
      ac.ctl.gearDown = false; ac.ctl.flapIdx = st.climb ? 1 : 0;
      const tas = st.kt * KT / Math.sqrt(atmosphere(y).sigma);
      ac.place(x, Math.max(y, this.world.ground(x, z).h + 300), z, hdg, tas, st.climb ? 6 : 1, false);
      if (st.climb) ac.ctl.throttle.fill(0.95);
    }
    // failures / complications
    this.applySessionFailures(s);
    this.fuelStart = ac.fuel;
    this.startTime = performance.now(); this.flightTime = 0;
    this.hud.glideRing = s.mode === 'emergency' || ac.allEnginesOut;
    this.hud.target = s.contract ? (() => { const d = this.world.db.byId.get(s.contract!.to)!; return { lat: d.lat, lon: d.lon, name: d.ident }; })() : null;
    // camera + world warmup
    this.camMode = ac.onGround ? 'chase' : 'chase';
    this.updateCamera(0.016, true);
    await this.world.warmup(this.camera, 5000);
    audio.init(); audio.setupEngines(t.engines, t.kind);
    this.setHudVisible(true);
    this.overlay.querySelector<HTMLButtonElement>('[data-a="slow"]')!.style.display = s.mode === 'free' ? '' : 'none';
    this.objective(this.objectiveText());
    if (s.mode === 'emergency' && s.scenario) this.message(s.scenario.name, 3);
    if (!this.running) { this.running = true; this.last = performance.now(); requestAnimationFrame(this.loop); }
  }

  private applySessionFailures(s: Session) {
    const ac = this.ac!;
    const sc = s.scenario;
    const ef = s.engineFail ?? 'none';
    const n = ac.engines.length;
    if (ef === 'all') ac.engines.forEach(e => { e.failed = true; e.n1 = 0.15; });
    else if (ef === 'one') { const i = Math.floor(Math.random() * n); ac.engines[i].failed = true; ac.engines[i].n1 = 0.1; }
    else if (ef === 'asym2') { ac.engines[0].failed = true; if (n > 2) ac.engines[1].failed = true; }
    if (!sc) return;
    if (sc.fire) { const i = ac.engines.findIndex(e => e.failed); const k = i >= 0 ? i : 0; ac.engines[k].fire = true; }
    if (sc.fuelLeak) ac.sys.fuelLeak = sc.fuelLeak;
    if (sc.fuelKg !== undefined) ac.fuel = sc.fuelKg;
    if (sc.hydraulics === false) ac.sys.hydraulics = false;
    if (sc.gearJam) { ac.sys.gearJam = true; ac.gearPos = 0; ac.ctl.gearDown = false; }
    if (sc.pitot === false) { ac.sys.pitot = false; ac.iasDisplayed = ac.ias; }
    if (sc.electrics === false) ac.sys.electrics = false;
    if (sc.wingLost) ac.breakWing(sc.wingLost, 'senaryo');
    if (sc.tailDamage) ac.sys.tailDamage = sc.tailDamage;
    if (ef === 'all' && ac.t.kind === 'jet') ac.fuel = Math.max(ac.fuel, 0);
  }

  private objectiveText(): string | null {
    const s = this.session!;
    if (s.mode === 'emergency' && s.scenario) return `<b>${s.scenario.name}</b><br>${s.scenario.desc}`;
    if (s.mode === 'cargo' && s.contract) { const c = s.contract; return `<b>${c.icon} ${c.cargo}</b> ${(c.kg / 1000).toFixed(1)} t → <b>${c.to}</b><br>Süre: ${c.deadlineMin} dk · ${c.distKm} km`; }
    if (s.mode === 'tutorial') return TUTORIAL[0].t;
    return null;
  }

  // ------------------------------------------------------------------ main loop
  private loop = (now: number) => {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    let dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 90) { this.autoQuality(); this.frameTimes = []; }
    env.uTime.value += dt;
    const ac = this.ac;
    if (ac && !this.paused) {
      this.controls.update(dt);
      const sdt = dt * this.timeScale;
      this.acc += sdt;
      const h = 1 / 120;
      let steps = 0;
      while (this.acc >= h && steps < 12) { this.weather.step(h, ac.agl); ac.step(h); this.acc -= h; steps++; }
      if (steps >= 12) this.acc = 0;
      this.flightTime += sdt;
      this.syncModel(sdt);
      this.effects(sdt);
      for (const d of this.debris) d.update(sdt);
      this.warnings();
      this.callouts();
      this.recordReplay(sdt);
      this.checkEnd(sdt);
      this.tutorial();
    }
    this.updateCamera(dt);
    if (this.world) this.world.update(this.camera, now);
    if (ac) {
      this.hud.update(ac, this.world);
      this.weather.updateRain(this.scene, this.camera, ac.vel, dt);
      audio.update({ n1: ac.engines.map(e => e.n1), running: ac.engines.map(e => !(e.failed || e.out || e.extinguished)), ias: ac.ias, onGround: ac.onGround, gs: ac.gs,
        shaker: ac.stall > 0.55 && !ac.onGround, cockpit: this.camMode === 'cockpit', kind: ac.t.kind, paused: this.paused });
    }
    if (this.msgTimer > 0) { this.msgTimer -= dt; if (this.msgTimer <= 0) this.msgEl.textContent = ''; }
    this.smoke.update(this.paused ? 0 : dt * this.timeScale); this.glow.update(this.paused ? 0 : dt * this.timeScale);
    this.renderer.render(this.scene, this.camera);
  };

  private autoQuality() {
    if (store.settings.quality !== 'auto') return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    if (avg > 0.024 && this.pr > 1) { this.pr = Math.max(1, this.pr - 0.2); this.renderer.setPixelRatio(this.pr); this.resize(); }
    else if (avg > 0.03 && this.world) this.world.terrain.splitFactor = Math.max(1.2, this.world.terrain.splitFactor - 0.2);
    else if (avg < 0.0145 && this.pr < Math.min(2, devicePixelRatio)) { this.pr = Math.min(2, this.pr + 0.1); this.renderer.setPixelRatio(this.pr); this.resize(); }
    else if (avg < 0.013 && this.world && this.world.terrain.splitFactor < 2.3) this.world.terrain.splitFactor += 0.1;
  }

  // ------------------------------------------------------------------ visuals
  private syncModel(dt: number) {
    const ac = this.ac!, m = this.model!;
    m.root.position.copy(ac.pos);
    m.root.quaternion.copy(ac.q);
    const fr = ac.flapPos / Math.max(1, ac.flapCount - 1);
    for (const f of m.flaps) f.rotation.x = fr * 0.6;
    for (const s of m.spoilers) s.rotation.x = -ac.spoilerPos * 0.9;
    m.gear.forEach((g, i) => {
      const collapsed = i < 3 ? ac.sys.gearCollapsed[i] : ac.sys.gearCollapsed[1];
      const p = collapsed ? 0 : ac.gearPos;
      g.group.visible = p > 0.03;
      g.group.rotation.x = g.kind === 'nose' ? -(1 - p) * 1.5 : 0;
      g.group.rotation.z = g.kind === 'main' ? (1 - p) * 1.5 * -g.side : 0;
    });
    ac.engines.forEach((e, i) => {
      const prop = m.props[i];
      if (prop) { prop.rotation.z += e.n1 * 60 * dt; const disc = m.propDiscs[i]; (disc.material as THREE.MeshBasicMaterial).opacity = clamp((e.n1 - 0.3) * 0.5, 0, 0.25); prop.visible = e.n1 < 0.75; }
    });
    // wing loss → detach outer wing as debris
    [0, 1].forEach(si => {
      const outer = m.wingOuter[si];
      if (ac.sys.wingLost[si] && outer.parent === m.root) {
        m.root.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(outer);
        const pivot = new THREE.Group();
        box.getCenter(pivot.position);
        this.scene.add(pivot);
        pivot.attach(outer); // keeps the world transform
        this.debris.push(new Debris(pivot, ac.vel, this.world));
      }
      if (!ac.sys.wingLost[si] && outer.parent !== m.root) {
        const piv = outer.parent; piv?.remove(outer); if (piv && piv !== this.scene) { this.scene.remove(piv); this.debris = this.debris.filter(d => d.obj !== piv); }
        outer.position.set(0, 0, 0); outer.quaternion.identity(); outer.scale.set(1, 1, 1); m.root.add(outer);
      }
    });
    // lights
    const t = performance.now() / 1000;
    const night = env.uNight.value;
    for (const b of m.lights.beacon) b.visible = Math.sin(t * 6.3) > 0.6;
    for (const s of m.lights.strobe) s.visible = (t % 1.2) < 0.06 && !ac.onGround;
    for (const n of m.lights.nav) n.scale.setScalar(1 + night * 1.5);
    for (const l of m.lights.landing) { l.visible = ac.gearPos > 0.5 && (ac.ra < 3000 * FT); l.scale.setScalar(1 + night * 4); }
  }

  private effects(dt: number) {
    const ac = this.ac!, m = this.model!;
    const fwd = ac.forward();
    for (let i = 0; i < ac.engines.length; i++) {
      const e = ac.engines[i];
      const ep = new THREE.Vector3(...ac.t.enginePos[i]).applyQuaternion(ac.q).add(ac.pos);
      if (e.fire && !e.extinguished) {
        for (let k = 0; k < 2; k++) this.glow.emit({ x: ep.x, y: ep.y, z: ep.z, vx: ac.vel.x * 0.9 + (Math.random() - 0.5) * 3, vy: ac.vel.y * 0.9 + Math.random() * 2, vz: ac.vel.z * 0.9 + (Math.random() - 0.5) * 3, max: 0.5, s0: 2.2, s1: 0.6, r: 1, g: 0.45 + Math.random() * 0.2, b: 0.1, a: 0.9, drag: 2 });
        this.smoke.emit({ x: ep.x, y: ep.y, z: ep.z, vx: ac.vel.x * 0.85, vy: ac.vel.y * 0.85 + 1, vz: ac.vel.z * 0.85, max: 5, s0: 2, s1: 14, r: 0.12, g: 0.12, b: 0.13, a: 0.45, drag: 1.2, rise: 1.5 });
      } else if ((e.failed || e.damaged > 0.3) && Math.random() < 0.3 && ac.tas > 30 && !ac.inWater)
        this.smoke.emit({ x: ep.x, y: ep.y, z: ep.z, vx: ac.vel.x * 0.8, vy: ac.vel.y * 0.8, vz: ac.vel.z * 0.8, max: 3, s0: 1, s1: 8, r: 0.3, g: 0.3, b: 0.32, a: 0.25, drag: 1 });
    }
    // fuel leak mist from broken wing / leak
    [0, 1].forEach(si => {
      if (!(ac.sys.wingLeak[si] || (ac.sys.fuelLeak > 0 && si === 0)) || ac.fuel <= 0 || ac.tas < 20) return;
      const x = (si ? 1 : -1) * ac.t.b / 2 * (ac.sys.wingLost[si] ? 0.55 : 0.4);
      const p = new THREE.Vector3(x, 0, ac.t.c * 0.3).applyQuaternion(ac.q).add(ac.pos);
      this.smoke.emit({ x: p.x, y: p.y, z: p.z, vx: ac.vel.x * 0.9, vy: ac.vel.y * 0.9, vz: ac.vel.z * 0.9, max: 2.2, s0: 0.6, s1: 7, r: 0.92, g: 0.94, b: 0.97, a: 0.35, drag: 1.4 });
    });
    // tyre smoke on touchdown, water spray
    if (ac.onGround && ac.gs > 60 && this.flightTime - (ac.touchdown.firstContact ? 0 : 0) > 0 && Math.random() < 0.2 && ac.ctl.brakes > 0)
      for (const s of [-1, 1]) { const p = new THREE.Vector3(s * ac.t.gearTrack / 2, -ac.t.gearH, ac.t.mainGearZ).applyQuaternion(ac.q).add(ac.pos); this.smoke.emit({ x: p.x, y: p.y, z: p.z, max: 1.5, s0: 1, s1: 5, r: 0.85, g: 0.85, b: 0.85, a: 0.25 }); }
    if (ac.inWater && ac.gs > 10) for (let k = 0; k < 4; k++) {
      const p = new THREE.Vector3((Math.random() - 0.5) * ac.t.b * 0.6, -ac.t.dia / 2, (Math.random() - 0.2) * ac.t.length * 0.5).applyQuaternion(ac.q).add(ac.pos);
      this.smoke.emit({ x: p.x, y: Math.max(p.y, 0), z: p.z, vx: ac.vel.x * 0.4 + (Math.random() - 0.5) * 8, vy: 4 + Math.random() * 8 * Math.min(1, ac.gs / 80), vz: ac.vel.z * 0.4 + (Math.random() - 0.5) * 8, max: 1.8, s0: 2, s1: 9, r: 0.92, g: 0.96, b: 1, a: 0.5, drag: 1, rise: -9 });
    }
    void fwd; void m;
  }

  private updateCamera(dt: number, snap = false) {
    const ac = this.ac; if (!ac) return;
    const cam = this.camera, t = ac.t;
    const span = Math.max(t.length, t.b);
    cam.fov = 60;
    const shake = ac.buffet * 0.02 + (ac.onGround ? Math.min(0.004, ac.gs * 0.00004) : 0) + this.weather.s.turb * 0.002;
    if (this.camMode === 'cockpit') {
      const eye = new THREE.Vector3(-t.dia * 0.13, t.dia * 0.28, -t.length * 0.42 + Math.max(1.2, t.length * 0.035)).applyQuaternion(ac.q).add(ac.pos);
      cam.position.copy(eye);
      const q = ac.q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-4 * DEG + this.orbit.pitch * 0.5 - 0.09, this.orbit.yaw - 0.6, 0, 'YXZ')));
      cam.quaternion.copy(q); cam.fov = 70;
    } else if (this.camMode === 'chase' || this.camMode === 'orbit') {
      const dist = span * 1.25 * (this.orbit.dist || 1);
      let yaw = this.orbit.yaw - 0.6, pitch = this.orbit.pitch;
      if (this.camMode === 'chase') { yaw = this.orbit.yaw - 0.6; }
      const base = this.camMode === 'chase' ? ac.hdg * DEG : 0;
      const dir = new THREE.Vector3(Math.sin(base + yaw + Math.PI) * Math.cos(pitch), Math.sin(pitch), -Math.cos(base + yaw + Math.PI) * Math.cos(pitch));
      const want = ac.pos.clone().addScaledVector(dir, dist);
      const g = this.world.ground(want.x, want.z).h;
      want.y = Math.max(want.y, g + 2);
      if (snap || this.chasePos.distanceTo(want) > dist * 4) this.chasePos.copy(want);
      else this.chasePos.lerp(want, 1 - Math.exp(-dt * (this.camMode === 'chase' ? 4 : 10)));
      cam.position.copy(this.chasePos);
      cam.lookAt(ac.pos.clone().add(new THREE.Vector3(0, t.dia * 0.4, 0)));
    } else if (this.camMode === 'wing') {
      const p = new THREE.Vector3(t.b * 0.18, t.dia * 0.55, t.length * 0.12).applyQuaternion(ac.q).add(ac.pos);
      cam.position.copy(p);
      const look = new THREE.Vector3(t.b * 0.45, t.dia * 0.1, -t.length * 0.05).applyQuaternion(ac.q).add(ac.pos);
      cam.up.set(0, 1, 0).applyQuaternion(ac.q); cam.lookAt(look); cam.up.set(0, 1, 0); cam.fov = 75;
    } else {
      // tower / cinematic: nearest airport tower, else a fixed point ahead of the aircraft
      let best: THREE.Vector3 | null = null, bd = 1e12;
      for (const a of this.world.active.values()) if (a.tower) { const d = a.tower.distanceToSquared(ac.pos); if (d < bd) { bd = d; best = a.tower; } }
      if (best && bd < 12000 * 12000) this.towerPos.copy(best);
      else if (snap || this.towerPos.distanceTo(ac.pos) > 4000) {
        const f = ac.forward(); this.towerPos.copy(ac.pos).addScaledVector(f, 1500).add(new THREE.Vector3(f.z * 300, 0, -f.x * 300));
        this.towerPos.y = this.world.ground(this.towerPos.x, this.towerPos.z).h + 30;
      }
      cam.position.copy(this.towerPos);
      cam.lookAt(ac.pos);
      const d = Math.max(1, this.towerPos.distanceTo(ac.pos));
      cam.fov = clamp(2 * Math.atan(span * 3 / d) / DEG, 3, 60);
    }
    if (shake > 0) cam.rotateX((Math.random() - 0.5) * shake), cam.rotateY((Math.random() - 0.5) * shake);
    cam.near = this.camMode === 'cockpit' ? 0.3 : 1; cam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ events & warnings
  private onEvent(type: string, data?: any) {
    const ac = this.ac!;
    switch (type) {
      case 'touchdown': {
        const vs = Math.abs(data.vs);
        if (data.site === 'water') { audio.crunch(); this.message(`Suya temas · ${Math.round(vs)} fpm`); }
        else { audio.screech(vs / 600); if (vs > 500) audio.thud(vs / 100); this.message(`Temas ${Math.round(vs)} fpm${data.belly ? ' (gövde üstü)' : ''}`); }
        break;
      }
      case 'wheelContact': if (data.kind === 'main' && data.speed > 40) audio.screech(0.15); break;
      case 'wingBreak': audio.crunch(); this.message(`${data.side < 0 ? 'SOL' : 'SAĞ'} KANAT KOPTU! Ters aileron + rudder ile tutun`, 5); audio.masterWarning(); break;
      case 'gearCollapse': audio.crunch(); this.message('İniş takımı çöktü!', 4); break;
      case 'engineFailed': audio.masterCaution(); this.message(`MOTOR ${data + 1} ARIZALI`, 3); this.hud.glideRing = this.session?.mode === 'emergency' || ac.allEnginesOut; break;
      case 'flameout': this.message(`MOTOR ${data + 1} YAKIT YOK`, 3); this.hud.glideRing = true; break;
      case 'engineWater': this.message('Motor suya girdi', 2); break;
      case 'tailStrike': this.message('Kuyruk sürtmesi!', 2); break;
      case 'crash': audio.crunch(); this.message(data, 6); break;
    }
  }

  private warnings() {
    const ac = this.ac!, w: [string, 'red' | 'amber' | 'green'][] = [];
    ac.engines.forEach((e, i) => { if (e.fire && !e.extinguished) w.push([`ENG ${i + 1} FIRE`, 'red']); else if (e.failed || e.out || e.extinguished) w.push([`ENG ${i + 1} ${e.out ? 'FLAMEOUT' : 'FAIL'}`, 'amber']); });
    if (ac.stall > 0.55 && !ac.onGround) w.push(['STALL', 'red']);
    const vfe = ac.t.flaps[Math.round(ac.flapPos)]?.vfe ?? 999;
    const over = ac.ias > Math.min(ac.t.vmo + 4, vfe + 4) || ac.mach > ac.t.mmo + 0.01;
    if (over) w.push(['OVERSPEED', 'red']);
    if (!ac.sys.hydraulics) w.push(['HYD SYS LO PR', 'amber']);
    if (!ac.sys.electrics) w.push(['ELEC EMER CONFIG', 'amber']);
    if (!ac.sys.pitot) w.push(['UNRELIABLE SPD', 'amber']);
    if (ac.sys.gearJam) w.push(['L/G JAMMED', 'amber']);
    if (ac.sys.flapsJam) w.push(['FLAPS JAM', 'amber']);
    if (ac.sys.fuelLeak > 0 || ac.sys.wingLeak.some(x => x)) w.push(['FUEL LEAK', 'amber']);
    if (ac.fuel < ac.t.fuelMax * 0.05) w.push([ac.fuel <= 0 ? 'FUEL EMPTY' : 'FUEL LO', 'amber']);
    if (ac.sys.wingLost.some(x => x)) w.push(['WING DAMAGE', 'red']);
    if (ac.sys.tailDamage > 0.2) w.push(['FLT CTL DAMAGE', 'amber']);
    // GPWS
    const ra = ac.ra / FT, vs = ac.vs;
    let gp: string | null = null;
    if (!ac.onGround && ra < 2500) {
      if (ra < 1000 && vs < -Math.max(1500, ra * 2.2) && ra > 30) gp = 'PULL UP';
      else if (ra < 2400 && vs < -Math.max(1000, ra * 1.4 + 400) && ra > 30) gp = 'SINK RATE';
      else if (ra < 500 && ra > 30 && ac.gearPos < 0.99 && ac.ias < 190 && !ac.sys.gearJam) gp = 'TOO LOW GEAR';
      else if (ra < 245 && ra > 30 && ac.flapPos < 1 && ac.ias < 160 && ac.gearPos > 0.9) gp = 'TOO LOW FLAPS';
    }
    if (gp) w.push([gp, 'red']);
    const key = w.map(x => x[0]).join('|');
    if (key !== this.onWarnings.join('|')) {
      const newOnes = w.filter(x => !this.onWarnings.includes(x[0]));
      for (const [txt, lvl] of newOnes) {
        if (txt.includes('FIRE')) audio.fireBell();
        else if (lvl === 'red' && !['STALL', 'PULL UP', 'SINK RATE', 'TOO LOW GEAR', 'TOO LOW FLAPS', 'OVERSPEED'].includes(txt)) audio.masterWarning();
        else if (lvl === 'amber') audio.masterCaution();
      }
      this.onWarnings = w.map(x => x[0]);
      this.warnEl.innerHTML = w.slice(0, 6).map(([t, l]) => `<div class="warn ${l}">${t}</div>`).join('');
      // fire handles
      this.fireEl.innerHTML = '';
      ac.engines.forEach((e, i) => {
        if (!e.fire || e.extinguished) return;
        const b = document.createElement('button'); b.className = 'btn danger ia'; b.textContent = `🔥 ${i + 1}. MOTOR YANGIN KOLU`;
        b.onclick = () => this.extinguish(i); this.fireEl.appendChild(b);
      });
    }
    audio.loop('fire', ac.engines.some(e => e.fire && !e.extinguished), 4000, () => audio.fireBell());
    audio.loop('stall', ac.stall > 0.55 && !ac.onGround, 1400, () => audio.say('STALL', 1000));
    audio.loop('over', over, 1000, () => audio.clacker());
    audio.loop('gpws', !!gp, 1600, () => audio.say(gp!, 1200));
  }

  extinguish(i: number) {
    const e = this.ac?.engines[i]; if (!e) return;
    e.extinguished = true; e.failed = true;
    setTimeout(() => { if (Math.random() < 0.85) { e.fire = false; this.message(`${i + 1}. motor yangını söndü`); } else { this.message('İkinci tüp boşaltıldı…'); setTimeout(() => { e.fire = false; this.message(`${i + 1}. motor yangını söndü`); }, 9000); } this.onWarnings = ['_']; }, 5000);
    this.message('Yangın tüpü boşaltıldı', 2);
  }

  private callouts() {
    const ac = this.ac!;
    if (ac.onGround || ac.vs > 200) { if (ac.ra / FT > 3000 || ac.onGround) this.calloutsDone.clear(); return; }
    const ra = ac.ra / FT;
    for (const c of [2500, 1000, 500, 100, 50, 40, 30, 20, 10]) {
      if (ra <= c && ra > c - (c >= 100 ? 60 : 6) && !this.calloutsDone.has(c)) {
        this.calloutsDone.add(c);
        audio.say(c === 2500 ? 'twenty five hundred' : c === 1000 ? 'one thousand' : c === 500 ? 'five hundred' : c === 100 ? 'one hundred' : String(c), 800, c < 100 ? 1.35 : 1.1);
      }
    }
    if (ra < 20 && ac.vs < -100 && !this.calloutsDone.has(-1) && ac.ctl.throttle.some(x => x > 0.2) && ac.t.fbw) { this.calloutsDone.add(-1); audio.say('retard', 1000, 1.3); }
  }

  private recordReplay(dt: number) {
    this.replayTimer += dt;
    if (this.replayTimer < 0.1) return;
    this.replayTimer = 0;
    const ac = this.ac!;
    if (this.replay.length > 9000) this.replay.splice(0, 3000);
    this.replay.push({ t: this.flightTime, p: [ac.pos.x, ac.pos.y, ac.pos.z], q: [ac.q.x, ac.q.y, ac.q.z, ac.q.w], g: ac.gearPos, f: ac.flapPos });
  }

  // ------------------------------------------------------------------ end of flight
  private endTimer = 0;
  private checkEnd(dt: number) {
    const ac = this.ac!, s = this.session!;
    if (this.ended) return;
    if (ac.crashed) {
      this.fadeEl.style.opacity = '1';
      this.endTimer += dt;
      if (this.endTimer > 1.6) this.finish('fatal');
      return;
    }
    if (ac.stopped && this.flightTime > 4 && ac.touchdown.firstContact) {
      this.endTimer += dt;
      if (this.endTimer > 2.5) this.finish(ac.inWater ? 'ditched' : this.onAirport() ? 'landed' : 'field');
    } else this.endTimer = 0;
  }
  private onAirport(): Airport | undefined {
    const ac = this.ac!;
    const g = this.world.ground(ac.pos.x, ac.pos.z);
    if (!g.flat) return undefined;
    let best: Airport | undefined, bd = 1e12;
    for (const a of this.world.active.values()) { const d = (a.x - ac.pos.x) ** 2 + (a.z - ac.pos.z) ** 2; if (d < bd) { bd = d; best = a; } }
    return best;
  }

  finish(outcome: FlightResult['outcome']) {
    if (this.ended) return;
    this.ended = true;
    const ac = this.ac!, s = this.session!;
    const vs = Math.abs(ac.touchdown.vs);
    const total = s.pax;
    let saved = total;
    const damage: string[] = [];
    if (ac.sys.wingLost.some(x => x)) damage.push('Kanat kaybı');
    if (ac.sys.gearCollapsed.some(x => x)) damage.push('İniş takımı çöktü');
    if (ac.sys.tailDamage > 0.2) damage.push('Kuyruk hasarı');
    if (ac.engines.some(e => e.damaged > 0.3)) damage.push('Motor hasarı');
    const decel = ac.peakDecel;
    if (outcome === 'fatal') saved = 0;
    else if (outcome === 'ditched') saved = Math.round(total * clamp(1 - Math.max(0, vs - 300) / 2500 - Math.max(0, decel - 2) * 0.05 - (ac.gearPos > 0.5 ? 0.08 : 0), 0.55, 1));
    else if (outcome === 'field') saved = Math.round(total * clamp(1 - Math.max(0, vs - 400) / 3000 - Math.max(0, decel - 2.5) * 0.04 - damage.length * 0.02, 0.6, 1));
    else saved = Math.round(total * clamp(1 - Math.max(0, vs - 900) / 4000 - (ac.sys.gearCollapsed.some(x => x) ? 0.01 : 0), 0.85, 1));
    let stars = 0;
    if (outcome !== 'fatal') {
      if (outcome === 'landed') stars = vs < 360 && !damage.length ? 5 : vs < 650 ? 4 : 3;
      else stars = saved / Math.max(1, total) > 0.97 ? 3 : 2;
      if (saved < total * 0.8) stars = Math.min(stars, 1);
    }
    const apt = outcome === 'landed' ? this.onAirport() : undefined;
    const r: FlightResult = {
      session: s, outcome, saved, total, vsFpm: vs, peakG: ac.peakG, site: outcome === 'landed' ? 'Pist' : outcome === 'ditched' ? 'Su' : outcome === 'field' ? 'Arazi / tarla' : '—',
      damage, stars, minutes: this.flightTime / 60, fuelUsed: Math.max(0, this.fuelStart - ac.fuel), atAirport: apt, reason: ac.crashReason, condLoss: damage.length * 0.15
    };
    audio.stopAll();
    setTimeout(() => { s.onEnd(r); }, outcome === 'fatal' ? 300 : 800);
  }

  endFlight(silent = false) {
    if (this.model) { this.scene.remove(this.model.root); disposeGroup(this.model.root); this.model = null; }
    for (const d of this.debris) { this.scene.remove(d.obj); disposeGroup(d.obj); }
    this.debris = [];
    this.ac = null; this.session = null;
    this.smoke.clear(); this.glow.clear();
    this.setHudVisible(false);
    this.objective(null);
    if (!silent) audio.stopAll();
  }

  /** menu backdrop: slow cinematic orbit over an airport */
  async backdrop(aptId: string) {
    const apt = this.world.db.byId.get(aptId); if (!apt) return;
    await this.world.ensureAirport(apt);
    const t0 = performance.now();
    const r = apt.runways[0];
    const spin = () => {
      if (this.ac || !this.running) return;
      const t = (performance.now() - t0) / 1000;
      const a = t * 0.04;
      this.camera.position.set(r.cx + Math.cos(a) * 3500, r.elev + 900, r.cz + Math.sin(a) * 3500);
      this.camera.lookAt(r.cx, r.elev, r.cz);
      requestAnimationFrame(spin);
    };
    if (!this.running) { this.running = true; this.last = performance.now(); requestAnimationFrame(this.loop); }
    spin();
  }

  // ------------------------------------------------------------------ tutorial
  private tutorial() {
    const s = this.session; if (!s || s.mode !== 'tutorial') return;
    const ac = this.ac!;
    const step = TUTORIAL[this.tutorialStep];
    if (!step) return;
    if (step.done(ac)) {
      this.tutorialStep++;
      const n = TUTORIAL[this.tutorialStep];
      audio.chime();
      this.objective(n ? n.t : '<b>Tebrikler!</b> Eğitimi tamamladınız. Serbest uçuşa devam edebilirsiniz.');
    }
  }
}

const TUTORIAL: { t: string; done: (a: Aircraft) => boolean }[] = [
  { t: '<b>1/7 Kalkış gücü</b><br>Sağdaki GAZ kolunu en üste (TOGA) itin.', done: a => a.ctl.throttle[0] > 0.9 },
  { t: '<b>2/7 Hızlanma</b><br>Pistte düz kalmak için DÜMEN kaydırıcısını kullanın. 140 kt\'da joystick\'i aşağı çekerek burnu kaldırın.', done: a => !a.onGround && a.ra > 30 * FT },
  { t: '<b>3/7 Teker topla</b><br>Pozitif tırmanış! GEAR kolunu yukarı alın.', done: a => !a.ctl.gearDown },
  { t: '<b>4/7 Flap topla</b><br>200 kt üzerinde FLAP kolunu 0\'a alın, 3000 ft\'e tırmanın.', done: a => a.ctl.flapIdx === 0 && a.alt / FT > 2800 },
  { t: '<b>5/7 Dönüş</b><br>Joystick ile 25° sola yatış yapın ve 90° dönün.', done: a => Math.abs(a.bank) > 20 },
  { t: '<b>6/7 Gücü azalt</b><br>Gazı %55 civarına çekin ve uçağı düz uçuşta tutun.', done: a => a.ctl.throttle[0] < 0.65 && Math.abs(a.bank) < 8 },
  { t: '<b>7/7 Yaklaşma</b><br>ND\'de havalimanını bulun. Flap ve tekeri açıp PAPI ışıkları 2 beyaz 2 kırmızı olacak şekilde alçalın ve inin. İnişten sonra FREN, REV ve SPOILER kullanın.', done: a => a.onGround && a.stopped }
];
export { NM, haversine, lerp, wrap180 };
