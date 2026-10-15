// 6-DOF flight model with per-wing lift, stall, ground effect, flaps/gear/spoilers, engines with spool lag,
// fuel & CG, landing gear struts, ditching hydrodynamics and structural damage (no explosions).
import * as THREE from 'three';
import { atmosphere, clamp, DEG, KT, FT, approach, lerp, smooth } from '../core/geo';
import type { AircraftType } from './aircraftData';
import type { Weather } from '../world/weather';
import type { World } from '../world/world';
import { insideObstacle } from '../world/airports';

export interface Engine { n1: number; failed: boolean; fire: boolean; fireT: number; damaged: number; out: boolean; extinguished: boolean; thrust: number; ff: number }
export interface FlightEvents { emit(type: string, data?: any): void }
export type Law = 'normal' | 'alternate' | 'direct';

const G = 9.80665;
const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3(), tmpQ = new THREE.Quaternion();

interface Contact { p: THREE.Vector3; kind: 'nose' | 'main' | 'tail' | 'belly' | 'tip' | 'eng'; side: number; idx: number; area: number }

export class Aircraft {
  t: AircraftType;
  // state
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  q = new THREE.Quaternion();
  w = new THREE.Vector3();   // body angular velocity (x pitch-up, y yaw-left, z roll-left)
  // mass
  payload = 0; fuel = 0;
  // controls (pilot)
  ctl = { pitch: 0, roll: 0, yaw: 0, throttle: [] as number[], flapIdx: 0, gearDown: true, spoiler: 0, spoilerArmed: false, brakes: 0, parkBrake: false, reverse: false, trim: 0 };
  // actual surfaces
  elev = 0; ail = 0; rud = 0; flapPos = 0; gearPos = 1; spoilerPos = 0; steer = 0;
  engines: Engine[] = [];
  // systems / damage
  sys = {
    hydraulics: true, electrics: true, pitot: true, flapsJam: false, gearJam: false,
    tailDamage: 0, wingLost: [0, 0] as [number, number], gearCollapsed: [false, false, false] as boolean[],
    fuelLeak: 0, wingLeak: [false, false] as [boolean, boolean], invincible: false, birdStrike: false
  };
  law: Law = 'normal';
  easy = false;
  // derived telemetry
  ias = 0; tas = 0; gs = 0; mach = 0; vs = 0; alpha = 0; beta = 0; nz = 1; agl = 0; ra = 0; alt = 0;
  pitch = 0; bank = 0; hdg = 0; trk = 0;
  stall = 0; buffet = 0; onGround = false; inWater = false; wow = [false, false, false];
  stallAlpha = 0.25;
  crashed = false; crashReason = ''; stopped = false;
  touchdown: { vs: number; t: number; g: number; site: 'runway' | 'field' | 'water' | 'none'; firstContact: number } = { vs: 0, t: 0, g: 0, site: 'none', firstContact: 0 };
  peakG = 1; peakDecel = 0; injuries = 0;
  iasDisplayed = 0;
  private fbw = { pInt: 0, holdBank: 0, rollHold: false };
  private contacts: Contact[] = [];
  private prevVel = new THREE.Vector3();
  private time = 0;
  frozen = false;
  wasAirborne = false;
  private lastTail = -10;
  private airT = 0;

  constructor(t: AircraftType, public world: World, public weather: Weather, public ev: FlightEvents) {
    this.t = t;
    for (let i = 0; i < t.engines; i++) this.engines.push({ n1: 0.22, failed: false, fire: false, fireT: 0, damaged: 0, out: false, extinguished: false, thrust: 0, ff: 0 });
    this.ctl.throttle = new Array(t.engines).fill(0);
    this.fuel = t.fuelMax * 0.4;
    this.payload = t.payloadMax * 0.6;
    this.buildContacts();
  }

  get mass() { return this.t.oew + this.payload + this.fuel; }
  get flapCount() { return this.t.flaps.length; }

  private buildContacts() {
    const t = this.t, r = t.dia / 2, semi = t.b / 2;
    const wingY = t.wing === 'low' ? -r * 0.62 : r * 0.82;
    const tipZ = -t.c * 0.45 + (semi - r) * Math.tan((t.sweep + 4) * DEG) + t.c * 0.2;
    const c: Contact[] = [];
    c.push({ p: new THREE.Vector3(0, -t.gearH, t.noseGearZ), kind: 'nose', side: 0, idx: 0, area: 0 });
    c.push({ p: new THREE.Vector3(-t.gearTrack / 2, -t.gearH, t.mainGearZ), kind: 'main', side: -1, idx: 1, area: 0 });
    c.push({ p: new THREE.Vector3(t.gearTrack / 2, -t.gearH, t.mainGearZ), kind: 'main', side: 1, idx: 2, area: 0 });
    const L = t.length, A = L * t.dia / 5;
    c.push({ p: new THREE.Vector3(0, -r * 0.95, -L * 0.36), kind: 'belly', side: 0, idx: 3, area: A });
    c.push({ p: new THREE.Vector3(0, -r, -L * 0.15), kind: 'belly', side: 0, idx: 4, area: A });
    c.push({ p: new THREE.Vector3(0, -r, L * 0.08), kind: 'belly', side: 0, idx: 5, area: A });
    c.push({ p: new THREE.Vector3(0, -r * 0.8, L * 0.3), kind: 'belly', side: 0, idx: 6, area: A });
    c.push({ p: new THREE.Vector3(0, -r * 0.2, L * 0.53), kind: 'tail', side: 0, idx: 7, area: A * 0.5 });
    c.push({ p: new THREE.Vector3(-semi, wingY + (semi - r) * (t.wing === 'low' ? 0.085 : 0), tipZ), kind: 'tip', side: -1, idx: 8, area: t.S * 0.1 });
    c.push({ p: new THREE.Vector3(semi, wingY + (semi - r) * (t.wing === 'low' ? 0.085 : 0), tipZ), kind: 'tip', side: 1, idx: 9, area: t.S * 0.1 });
    // mid-span wing points (for water contact & wing-on-ground)
    c.push({ p: new THREE.Vector3(-semi * 0.5, wingY + semi * 0.5 * 0.05, tipZ * 0.5), kind: 'tip', side: -1, idx: 10, area: t.S * 0.15 });
    c.push({ p: new THREE.Vector3(semi * 0.5, wingY + semi * 0.5 * 0.05, tipZ * 0.5), kind: 'tip', side: 1, idx: 11, area: t.S * 0.15 });
    const nd = t.kind === 'jet' ? Math.max(1.1, Math.sqrt(t.thrust) * 0.0056) : 1;
    // keep ≥0.45 m pod clearance at static strut compression (real airliners: ~0.5 m)
    const minY = -(t.gearH - 0.22 - 0.45);
    t.enginePos.forEach(([x, y, z], i) => { if (t.engineMount === 'wing') c.push({ p: new THREE.Vector3(x, Math.max(y - nd / 2, minY), z), kind: 'eng', side: Math.sign(x), idx: 12 + i, area: nd * nd }); });
    // belly/tail points never below the gear plane at rest
    for (const k of c) if (k.kind === 'belly' || k.kind === 'tail' || k.kind === 'tip') k.p.y = Math.max(k.p.y, -(t.gearH - 0.22 - 0.3));
    this.contacts = c;
  }

  /** place aircraft. hdg deg true, speed m/s along heading */
  place(x: number, y: number, z: number, hdg: number, speed: number, pitchDeg = 0, onGround = false) {
    this.pos.set(x, y, z);
    this.q.setFromEuler(new THREE.Euler(pitchDeg * DEG, -hdg * DEG, 0, 'YXZ'));
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(this.q);
    this.vel.copy(f).multiplyScalar(speed);
    this.prevVel.copy(this.vel);
    this.w.set(0, 0, 0);
    this.crashed = false; this.stopped = false; this.crashReason = '';
    this.touchdown = { vs: 0, t: 0, g: 0, site: 'none', firstContact: 0 };
    this.peakG = 1; this.peakDecel = 0; this.injuries = 0;
    this.fbw = { pInt: 0, holdBank: 0, rollHold: false };
    this.onGround = onGround;
    this.wasAirborne = !onGround; this.airT = 0;
    const n1 = onGround ? 0.2 : 0.6;
    for (const e of this.engines) if (!e.failed) e.n1 = n1;
    this.ctl.throttle.fill(onGround ? 0 : 0.6);
    this.gearPos = this.ctl.gearDown ? 1 : 0;
    this.flapPos = this.ctl.flapIdx;
    this.elev = this.ail = this.rud = 0;
  }

  // ------------------------------------------------------------ aerodynamics helpers
  private flapCfg() {
    const f = this.t.flaps, i = Math.floor(this.flapPos), fr = this.flapPos - i;
    const a = f[Math.min(i, f.length - 1)], b = f[Math.min(i + 1, f.length - 1)];
    return { dCL: lerp(a.dCL, b.dCL, fr), dCLmax: lerp(a.dCLmax, b.dCLmax, fr), dCD: lerp(a.dCD, b.dCD, fr), frac: this.flapPos / (f.length - 1) };
  }
  /** lift coefficient curve with smooth stall and post-stall flat plate */
  CL(alpha: number, cfg: { dCL: number; dCLmax: number }, slatsOk = true): number {
    const t = this.t, CLa = t.CLa;
    const CLmax = t.CLmax + cfg.dCLmax;
    const a0 = -2.2 * DEG - cfg.dCL / CLa;
    const as = a0 + CLmax / CLa * 1.08;     // stall alpha (slight rounding)
    let cl: number;
    if (alpha < as - 0.05) cl = CLa * (alpha - a0);
    else if (alpha < as) { const k = (alpha - (as - 0.05)) / 0.05; cl = lerp(CLa * (alpha - a0), CLmax, k * k); cl = Math.min(cl, CLmax); }
    else {
      const k = Math.min(1, (alpha - as) / (10 * DEG));
      const plate = 1.15 * Math.sin(2 * alpha);
      cl = lerp(CLmax * (1 - 0.35 * k), plate, smooth(0, 1, (alpha - as) / (25 * DEG)));
    }
    if (alpha < -0.25) cl = Math.max(-1.0, 1.15 * Math.sin(2 * alpha));
    this.stallAlpha = as;
    return cl;
  }

  // ------------------------------------------------------------ main step
  step(dt: number) {
    if (this.frozen || this.crashed) return;
    this.time += dt;
    const t = this.t, m = this.mass;
    const qInv = tmpQ.copy(this.q).invert();
    // ground info under aircraft
    const gnd = this.world.ground(this.pos.x, this.pos.z);
    this.agl = this.pos.y - gnd.h;
    this.ra = this.agl - t.gearH;
    this.alt = this.pos.y;
    const atm = atmosphere(this.pos.y);
    const rho = atm.rho;
    // air-relative velocity in body frame
    const wind = this.weather.wind(Math.max(0, this.agl), tmpV2);
    const va = tmpV.copy(this.vel).sub(wind).applyQuaternion(qInv);
    const V = Math.max(0.01, va.length());
    const alpha = Math.atan2(-va.y, -va.z);
    const beta = Math.asin(clamp(va.x / V, -1, 1));
    this.alpha = alpha; this.beta = beta;
    const qd = 0.5 * rho * V * V;
    const S = t.S, b = t.b, c = t.c;
    // conventional rates: p roll right, q pitch up, r yaw right
    const p = -this.w.z, qq = this.w.x, r = -this.w.y;

    this.systemsStep(dt, V);
    this.controlLaws(dt, V, qd, p, qq, r);

    const F = new THREE.Vector3();   // body forces
    const M = new THREE.Vector3();   // body torques
    const addForceAt = (f: THREE.Vector3, at: THREE.Vector3) => { F.add(f); M.add(new THREE.Vector3().crossVectors(at, f)); };

    // ---- lift per wing half
    const cfg = this.flapCfg();
    const ge = this.ra < b ? 1 + 0.25 * Math.pow(1 - clamp(this.ra / b, 0, 1), 2.2) : 1;
    const AR = b * b / S;
    let kInd = 1 / (Math.PI * t.e * AR);
    kInd /= ge;
    const vyz = new THREE.Vector3(0, va.y, va.z).normalize();
    const liftDir = new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), vyz).normalize();
    const vhat = va.clone().divideScalar(V);
    const arm = b * 0.21;
    let CLtot = 0, stallMax = 0;
    for (const s of [-1, 1]) {
      const lost = this.sys.wingLost[s < 0 ? 0 : 1];
      const aLoc = alpha + s * p * arm / V + (lost ? -0.02 : 0);
      let cl = this.CL(aLoc, cfg) * ge;
      cl -= this.spoilerPos * 0.45 * (cl > 0 ? 1 : 0);
      // aileron contributes a little lift change per side
      cl += -s * this.ail * 0.18 * (1 - lost * 0.7);
      const k = 1 - lost * 0.58;
      const L = qd * S * 0.5 * cl * k;
      CLtot += cl * k * 0.5;
      const armS = s * arm * (1 - lost * 0.4);
      addForceAt(liftDir.clone().multiplyScalar(L), new THREE.Vector3(armS, 0, 0));
      stallMax = Math.max(stallMax, (aLoc - (this.stallAlpha - 3.5 * DEG)) / (3.5 * DEG));
      // asymmetric drag from broken wing
      if (lost) addForceAt(vhat.clone().multiplyScalar(-qd * S * 0.03 * lost), new THREE.Vector3(s * arm * 0.7, 0, 0));
    }
    this.stall = clamp(stallMax, 0, 1.5);
    this.buffet = clamp(stallMax, 0, 1) * clamp(V / 40, 0, 1);

    // ---- drag
    const gearDrag = 0.017 * this.gearPos * (this.sys.gearCollapsed.some(x => x) ? 1.4 : 1);
    let CD = t.CD0 + kInd * CLtot * CLtot + cfg.dCD + gearDrag + this.spoilerPos * 0.07 + this.sys.tailDamage * 0.01;
    if (alpha > this.stallAlpha) CD += 1.1 * Math.sin(alpha - this.stallAlpha) ** 2 + 0.05;
    CD += Math.abs(beta) * 0.25;
    for (const e of this.engines) if (e.failed || e.out) CD += t.kind === 'jet' ? 0.0012 : (e.n1 > 0.05 ? 0.004 : 0.0015);
    const mach = V / atm.a;
    if (mach > t.mmo - 0.02) CD += (mach - (t.mmo - 0.02)) * 0.6;
    F.addScaledVector(vhat, -qd * S * CD);
    // side force
    F.x += qd * S * (-0.85 * beta + 0.16 * this.rud * (1 - this.sys.tailDamage * 0.6));

    // ---- thrust
    this.engineStep(dt, V, atm, mach, F, M);

    // ---- aero moments (conventional), converted to body torque
    const tailK = 1 - this.sys.tailDamage * 0.65;
    const auth = this.sys.hydraulics ? 1 : 0.35;
    const vn = Math.max(V, 15);
    const Cm = 0.07 - 1.15 * alpha - 19 * (qq * c / (2 * vn)) + 0.62 * this.elev * auth * tailK - 0.06 * cfg.frac + 0.03 * this.spoilerPos + 0.008 * this.gearPos
      + (alpha > this.stallAlpha ? -0.25 * (alpha - this.stallAlpha) : 0);
    const lostL = this.sys.wingLost[0], lostR = this.sys.wingLost[1];
    const ailAuth = (1 - 0.5 * (lostL + lostR) / 2) * auth * (1 - this.stall * 0.5);
    const Cl = -0.09 * beta - 0.32 * (p * b / (2 * vn)) + 0.09 * (r * b / (2 * vn)) + 0.13 * this.ail * ailAuth
      + 0.04 * (lostL - lostR) * 0.0;
    const Cn = 0.13 * beta * tailK - 0.17 * (r * b / (2 * vn)) + 0.085 * this.rud * auth * tailK - 0.012 * this.ail;
    M.x += qd * S * c * Cm;
    M.y += -qd * S * b * Cn;
    M.z += -qd * S * b * Cl;
    // turbulence-driven buffet
    if (this.buffet > 0) { M.x += (Math.random() - 0.5) * qd * S * c * 0.03 * this.buffet; M.z += (Math.random() - 0.5) * qd * S * b * 0.004 * this.buffet; }

    // ---- gravity (world) → body
    const gW = new THREE.Vector3(0, -m * G, 0);
    F.add(gW.applyQuaternion(qInv));

    // ---- ground & water contacts
    this.contactStep(dt, F, M, gnd.h);

    // ---- integrate
    const Fw = F.applyQuaternion(this.q);
    this.vel.addScaledVector(Fw, dt / m);
    this.pos.addScaledVector(this.vel, dt);
    const L = t.length, I = { x: m * (L * 0.19) ** 2, z: m * (b * 0.165) ** 2, y: 0 };
    I.y = I.x + I.z * 0.92;
    const w = this.w;
    const Iw = new THREE.Vector3(I.x * w.x, I.y * w.y, I.z * w.z);
    const gyro = new THREE.Vector3().crossVectors(w, Iw);
    w.x += (M.x - gyro.x) / I.x * dt;
    w.y += (M.y - gyro.y) / I.y * dt;
    w.z += (M.z - gyro.z) / I.z * dt;
    w.clampLength(0, 3);
    const dq = new THREE.Quaternion(w.x * dt * 0.5, w.y * dt * 0.5, w.z * dt * 0.5, 1);
    this.q.multiply(dq).normalize();

    // ---- telemetry
    const acc = tmpV2.copy(this.vel).sub(this.prevVel).divideScalar(dt);
    this.prevVel.copy(this.vel);
    const accB = acc.clone().add(new THREE.Vector3(0, G, 0)).applyQuaternion(qInv);
    this.nz = lerp(this.nz, accB.y / G, 0.08);
    const decel = this.onGround || this.inWater ? -accB.z / G : 0;
    this.peakDecel = Math.max(this.peakDecel, Math.abs(lerp(0, decel, 1)));
    this.peakG = Math.max(this.peakG, Math.abs(this.nz));
    this.tas = V; this.mach = mach;
    this.ias = V * Math.sqrt(atm.sigma) / KT;
    this.gs = Math.hypot(this.vel.x, this.vel.z) / KT;
    this.vs = this.vel.y / FT * 60;
    const e = new THREE.Euler().setFromQuaternion(this.q, 'YXZ');
    this.pitch = e.x / DEG; this.bank = -e.z / DEG; this.hdg = ((-e.y / DEG) % 360 + 360) % 360;
    this.trk = ((Math.atan2(this.vel.x, -this.vel.z) / DEG) + 360) % 360;
    // unreliable airspeed (pitot blocked): indicated speed drifts with altitude like a blocked pitot
    if (!this.sys.pitot) this.iasDisplayed = clamp(this.iasDisplayed + (this.vs / 60 * FT) * 0.02 * dt * 60 * 0.1 + (Math.random() - 0.5) * 0.4, 30, 450);
    else this.iasDisplayed = this.ias;
    // stopped?
    if (this.onGround && this.vel.length() < 0.6 && this.ctl.throttle.every(x => x < 0.2)) this.stopped = true; else if (this.vel.length() > 2) this.stopped = false;
    if (this.inWater && this.vel.length() < 1.5) this.stopped = true;
  }

  // ------------------------------------------------------------ systems
  private systemsStep(dt: number, V: number) {
    const t = this.t, c = this.ctl;
    // flaps (hydraulic) – rate ~ 1 setting / 4 s
    if (!this.sys.flapsJam && this.sys.hydraulics) this.flapPos = approach(this.flapPos, c.flapIdx, dt / 4.5);
    else if (!this.sys.flapsJam && !this.sys.hydraulics) this.flapPos = approach(this.flapPos, c.flapIdx, dt / 25);
    // gear: hydraulic retraction, gravity extension when hydraulics lost
    if (!this.sys.gearJam) {
      if (c.gearDown) this.gearPos = approach(this.gearPos, 1, dt / (this.sys.hydraulics ? 8 : 18));
      else if (this.sys.hydraulics && !this.onGround) this.gearPos = approach(this.gearPos, 0, dt / 8);
    }
    // spoilers: armed → deploy on touchdown
    let sp = c.spoiler;
    if (c.spoilerArmed && this.onGround && this.ias > 40 && c.throttle.every(x => x < 0.15)) sp = 1;
    if (!this.sys.hydraulics) sp = 0;
    this.spoilerPos = approach(this.spoilerPos, sp, dt * 1.6);
    // fuel leak + wing leaks
    let leak = this.sys.fuelLeak + (this.sys.wingLeak[0] ? 4 : 0) + (this.sys.wingLeak[1] ? 4 : 0);
    leak *= t.mtow / 70000;
    if (leak > 0) this.fuel = Math.max(0, this.fuel - leak * dt);
    // electrics failure → direct law, no ND
    const fbwOK = t.fbw && this.sys.electrics && this.sys.hydraulics;
    this.law = fbwOK ? (this.sys.tailDamage > 0.5 || this.sys.wingLost.some(x => x) ? 'alternate' : 'normal') : 'direct';
  }

  private engineStep(dt: number, V: number, atm: { sigma: number; rho: number }, mach: number, F: THREE.Vector3, M: THREE.Vector3) {
    const t = this.t;
    let burn = 0;
    const idle = this.onGround ? 0.2 : 0.24;
    const noFuel = this.fuel <= 0.5;
    this.engines.forEach((e, i) => {
      let target = idle + (1 - idle) * clamp(this.ctl.throttle[i] ?? 0, 0, 1) * (e.damaged > 0 ? 1 - e.damaged * 0.6 : 1);
      if (noFuel && !e.out) { e.out = true; this.ev.emit('flameout', i); }
      if (!noFuel && e.out && !e.failed && !e.fire && !e.extinguished) e.out = false;
      if (e.failed || e.out || e.extinguished) target = V > 60 && t.kind === 'jet' ? 0.08 + V / 2000 : 0;
      const up = target > e.n1;
      const tau = up ? t.spool * (e.n1 < 0.5 ? 1.2 : 0.6) : t.spool * 0.55;
      e.n1 += (target - e.n1) * Math.min(1, dt / Math.max(0.3, tau));
      // fire: burns then fails the engine unless extinguished
      if (e.fire) {
        e.fireT += dt;
        if (e.fireT > 25 && !e.failed) { e.failed = true; this.ev.emit('engineFailed', i); }
      }
      const running = !(e.failed || e.out || e.extinguished);
      const f = running ? Math.max(0, (e.n1 - idle) / (1 - idle)) : 0;
      let T: number;
      const idleT = running ? 0.035 : 0;
      if (t.kind === 'jet') T = t.thrust * (Math.pow(f, 1.5) * 0.965 + idleT) * Math.pow(atm.sigma, 0.75) * (1 - 0.3 * mach);
      else {
        const P = (t.power ?? 500) * 1000 * Math.pow(f, 1.2) * Math.pow(atm.sigma, 0.85);
        T = Math.min(t.thrust * (Math.pow(f, 1.2) + idleT), P * 0.82 / Math.max(V, 22)) + t.thrust * idleT;
        if (!running && V > 20) T = -t.thrust * 0.02 * (V / 60); // windmilling/feathered drag
      }
      let dir = -1; // forward thrust along -z
      if (this.ctl.reverse && this.onGround && running) { T *= t.kind === 'jet' ? 0.42 : 0.55; dir = 1; }
      e.thrust = T * -dir;
      const [x, y, z] = t.enginePos[i];
      // engine on a lost wing section → gone
      const si = x < 0 ? 0 : 1;
      if (this.sys.wingLost[si] && Math.abs(x) > t.b / 2 * 0.56) { e.failed = true; T = 0; }
      const fv = new THREE.Vector3(0, 0, dir * T);
      F.add(fv);
      M.add(new THREE.Vector3().crossVectors(new THREE.Vector3(x, y, z), fv));
      const tsfc = t.tsfc || 0;
      e.ff = running ? (t.kind === 'jet' ? tsfc * Math.abs(T) + 0.05 * t.thrust / 120000 : ((t.power ?? 500) * 8.3e-5 * (0.12 + f * 0.88))) : 0;
      burn += e.ff;
    });
    this.fuel = Math.max(0, this.fuel - burn * dt);
  }

  // ------------------------------------------------------------ control laws
  private controlLaws(dt: number, V: number, qd: number, p: number, qq: number, r: number) {
    const c = this.ctl, t = this.t;
    const rate = (cur: number, tgt: number, rps: number) => approach(cur, tgt, rps * dt);
    const onG = this.onGround;
    // nosewheel steering (tiller+rudder), effective at low speed
    this.steer = rate(this.steer, c.yaw * (this.ias < 30 ? 1 : clamp(1 - (this.ias - 30) / 60, 0.08, 1)), 2.5);
    if (this.law === 'normal' && !onG && V > 45) {
      // ---------- FBW normal law (C*: load factor demand, bank hold, protections)
      const bankR = this.bank * DEG;
      const nzBank = 1 / Math.max(0.45, Math.cos(clamp(bankR, -1.1, 1.1)));
      let nzCmd = 1 + c.pitch * (c.pitch > 0 ? 1.5 : 1.0);
      nzCmd *= Math.abs(this.bank) < 33 ? nzBank : 1;
      // alpha protection
      const aProt = this.stallAlpha - 4 * DEG, aMax = this.stallAlpha - 1.5 * DEG;
      if (this.alpha > aProt) nzCmd = Math.min(nzCmd, 1 - (this.alpha - aProt) / (aMax - aProt) * 0.8 + (c.pitch > 0 ? 0 : 0.2));
      if (this.ias > t.vmo + 8) nzCmd = Math.max(nzCmd, 1.25);
      const qNeed = (nzCmd - this.nz) * 0.12 + (nzCmd - 1) * 9.81 / Math.max(V, 60) * 0.8;
      const err = qNeed - qq;
      this.fbw.pInt = clamp(this.fbw.pInt + err * dt * 2.2, -0.6, 0.9);
      const elevCmd = clamp(this.fbw.pInt + err * 2.5, -1, 1);
      this.elev = rate(this.elev, elevCmd, 1.5);
      // roll: rate command, bank hold, 33° spiral stability, 67° limit
      let pCmd = c.roll * 15 * DEG;
      if (Math.abs(c.roll) < 0.05) {
        if (!this.fbw.rollHold) { this.fbw.rollHold = true; this.fbw.holdBank = clamp(this.bank, -33, 33); }
        pCmd = (this.fbw.holdBank - this.bank) * DEG * 0.8;
      } else this.fbw.rollHold = false;
      if (Math.abs(this.bank) > 67 && Math.sign(pCmd) === Math.sign(this.bank)) pCmd = 0;
      if (Math.abs(this.bank) > 33 && Math.abs(c.roll) < 0.05) pCmd = -Math.sign(this.bank) * 3 * DEG;
      this.ail = rate(this.ail, clamp((pCmd - p) * 2.2, -1, 1), 2.5);
      // yaw damper + turn coordination, pilot rudder added
      this.rud = rate(this.rud, clamp(c.yaw * 0.9 + this.beta * 3.5 - r * 0.5, -1, 1), 1.5);
    } else {
      // ---------- direct law (+ easy assist)
      let pe = c.pitch, ra = c.roll, ya = c.yaw;
      if (this.easy && !onG) {
        // stability assist: auto-trim toward level flight, wing leveler, yaw damper, stall nudge
        const pitchHold = -(qq * 1.2);
        pe = clamp(pe + pitchHold + this.ctl.trim, -1, 1);
        if (Math.abs(ra) < 0.05) ra = clamp(-this.bank * 0.03 - p * 0.4, -0.5, 0.5);
        ya = clamp(ya + this.beta * 3 - r * 0.4, -1, 1);
        if (this.stall > 0.3) pe = Math.min(pe, -0.2);
        // auto trim integrates elevator demand slowly
        this.ctl.trim = clamp(this.ctl.trim + (c.pitch) * dt * 0.02, -0.6, 0.6);
      } else pe = clamp(pe + c.trim, -1, 1);
      if (!this.easy && !onG && t.kind !== 'piston') ya = clamp(ya + this.beta * 1.2 - r * 0.25, -1, 1); // basic yaw damper
      this.elev = rate(this.elev, pe, 2.2);
      this.ail = rate(this.ail, ra, 2.8);
      this.rud = rate(this.rud, ya, 1.8);
      if (onG) this.fbw.pInt = 0;
    }
  }

  // ------------------------------------------------------------ contacts
  private contactStep(dt: number, F: THREE.Vector3, M: THREE.Vector3, _gh: number) {
    const t = this.t, m = this.mass;
    const qInv = new THREE.Quaternion().copy(this.q).invert();
    const wW = this.w.clone().applyQuaternion(this.q);
    let anyGround = false, anyWater = false;
    const travel = 0.55;
    const rain = this.weather.s.rain;
    for (const ct of this.contacts) {
      const isGear = ct.kind === 'nose' || ct.kind === 'main';
      if (isGear && (this.gearPos < 0.9 || this.sys.gearCollapsed[ct.idx])) continue;
      if (ct.kind === 'tip' && this.sys.wingLost[ct.side < 0 ? 0 : 1] && ct.idx < 10) continue;
      const rB = ct.p;
      const P = rB.clone().applyQuaternion(this.q).add(this.pos);
      const g = this.world.ground(P.x, P.z);
      const pen = g.h - P.y;
      // obstacle (building) strikes for wingtips / fuselage
      if (!isGear && this.vel.length() > 8) {
        for (const o of this.world.obstacles(P.x, P.z, 2)) {
          if (insideObstacle(o, P.x, P.y, P.z)) {
            if (ct.kind === 'tip') this.breakWing(ct.side, 'bina');
            else if (ct.kind !== 'eng') this.crash('Binaya çarpma');
            else this.damageEngine(ct.idx - 12, 1);
          }
        }
      }
      if (pen <= 0) { if (isGear) this.wow[ct.idx] = false; continue; }
      const vP = this.vel.clone().add(new THREE.Vector3().crossVectors(wW, P.clone().sub(this.pos)));
      const vn = -vP.y; // closing speed (m/s, + downward)
      if (g.water) {
        anyWater = true;
        this.waterContact(ct, P, pen, vP, vn, F, M, qInv, isGear);
        continue;
      }
      anyGround = true;
      if (isGear) {
        const share = ct.kind === 'nose' ? 0.1 : 0.45;
        const k = share * m * G / 0.22;
        const cdamp = 2 * 0.55 * Math.sqrt(k * m * share);
        const comp = Math.min(pen, travel);
        let N = k * comp + cdamp * vn * (vn > 0 ? 1 : 0.4);
        if (pen > travel) N += k * 12 * (pen - travel) + cdamp * 3 * Math.max(vn, 0);
        N = Math.max(0, N);
        if (!this.wow[ct.idx]) {
          this.wow[ct.idx] = true;
          if (ct.kind === 'main') this.onTouchdown(vn, g.flat);
          this.ev.emit('wheelContact', { kind: ct.kind, vn, speed: this.gs });
        }
        // gear collapse on hard landing / overload
        const limit = (ct.kind === 'nose' ? 0.35 : 1.25) * m * G * (this.sys.invincible ? 99 : 1);
        if ((N > limit * 2.4 || (vn > 4.6 && pen > travel * 0.8)) && !this.sys.invincible) this.collapseGear(ct.idx);
        // wheel friction
        const fw = new THREE.Vector3(0, 0, -1).applyQuaternion(this.q);
        if (ct.kind === 'nose') fw.applyAxisAngle(new THREE.Vector3(0, 1, 0).applyQuaternion(this.q), -this.steer * 1.1);
        fw.y = 0; fw.normalize();
        const side = new THREE.Vector3(-fw.z, 0, fw.x);
        const vf = vP.dot(fw), vs = vP.dot(side);
        let mu = 0.018;
        const brake = Math.max(this.ctl.brakes, this.ctl.parkBrake ? 1 : 0);
        if (ct.kind === 'main') mu += brake * (0.55 - rain * 0.25) * (this.sys.hydraulics ? 1 : 0.6);
        const Ff = -Math.tanh(vf / 0.4) * mu * N;
        const muL = 0.75 - rain * 0.3;
        const Fs = -clamp(vs * N * 0.9, -muL * N, muL * N);
        const fWorld = new THREE.Vector3(0, N, 0).addScaledVector(fw, Ff).addScaledVector(side, Fs);
        const fB = fWorld.applyQuaternion(qInv);
        F.add(fB); M.add(new THREE.Vector3().crossVectors(rB, fB));
      } else {
        // structure on the ground: skid with high friction; check severity
        const k = m * G / 0.3;
        const N = Math.max(0, k * Math.min(pen, 1.5) + 2 * Math.sqrt(k * m) * 0.35 * Math.max(vn, 0));
        const vh = new THREE.Vector3(vP.x, 0, vP.z);
        const spd = vh.length();
        const mu = ct.kind === 'eng' ? 0.6 : 0.45;
        const fWorld = new THREE.Vector3(0, N, 0);
        if (spd > 0.05) fWorld.addScaledVector(vh.normalize(), -mu * N);
        const fB = fWorld.applyQuaternion(qInv);
        F.add(fB); M.add(new THREE.Vector3().crossVectors(rB, fB));
        if (this.sys.invincible) continue;
        if (ct.kind === 'tip' && this.gs > 25) this.breakWing(ct.side, 'zemin');
        else if (ct.kind === 'eng' && this.gs > 20) this.damageEngine(ct.idx - 12, 1);
        else if (ct.kind === 'tail' && this.time - this.lastTail > 2) { this.lastTail = this.time; if (vn > 1.2) this.sys.tailDamage = Math.min(1, this.sys.tailDamage + 0.2 + vn * 0.05); this.ev.emit('tailStrike'); }
        if (ct.kind === 'belly' || ct.kind === 'tail') {
          if (!this.touchdown.firstContact) this.onTouchdown(vn, g.flat, true);
          if (vn > 8.5) this.crash('Gövde ağır darbe aldı');
          // terrain slope impact: if moving fast into rising ground
          if (this.gs > 70 && pen > 3) this.crash('Araziye yüksek hızda çarpma');
        }
      }
    }
    this.onGround = anyGround;
    this.inWater = anyWater;
    if (!anyGround && !anyWater) { this.airT += dt; if (this.airT > 1.5) this.wasAirborne = true; } else this.airT = 0;
    // rolled over / inverted on the ground
    if ((anyGround || anyWater) && Math.abs(this.bank) > 95 && !this.sys.invincible) this.crash('Uçak ters döndü');
    // high-speed terrain impact (nose first)
    if (!this.sys.invincible && (anyGround) && this.vel.y < -14) this.crash('Araziye çarpma');
  }

  private waterContact(ct: Contact, P: THREE.Vector3, depth: number, vP: THREE.Vector3, vn: number, F: THREE.Vector3, M: THREE.Vector3, qInv: THREE.Quaternion, isGear: boolean) {
    const t = this.t, rho = 1025;
    const d = Math.min(depth, t.dia);
    if (!this.touchdown.firstContact && (ct.kind === 'belly' || ct.kind === 'tail' || isGear)) this.onTouchdown(vn, false, true, true);
    // buoyancy + planing + hydrodynamic drag
    const A = isGear ? 0.6 : ct.area || 4;
    const buoy = rho * G * A * d * 0.6;
    const v = vP.length();
    const planing = 0.5 * rho * A * 0.04 * Math.max(0, -vP.y) * v;
    const fWorld = new THREE.Vector3(0, buoy + planing, 0);
    const cd = isGear ? 0.5 : ct.kind === 'eng' ? 0.22 : ct.kind === 'tip' ? 0.03 : 0.011;
    if (v > 0.1) fWorld.addScaledVector(vP, -0.5 * rho * cd * A * Math.min(1, d / 0.6) * v / Math.max(1, Math.sqrt(t.mtow / 50000)));
    const fB = fWorld.applyQuaternion(qInv);
    F.add(fB); M.add(new THREE.Vector3().crossVectors(ct.p, fB));
    if (ct.kind === 'eng' && !this.engines[ct.idx - 12]?.failed) { this.engines[ct.idx - 12].failed = true; this.ev.emit('engineWater', ct.idx - 12); }
    if (this.sys.invincible) return;
    if (ct.kind === 'belly' && ct.idx === 3 && depth > t.dia * 0.8 && this.gs > 70) this.crash('Burun suya gömüldü');
    if (vn > 9) this.crash('Suya çok sert çarpma');
    if (this.peakDecel > 9.5) this.crash('Suya çarpmada aşırı yavaşlama');
  }

  private onTouchdown(vn: number, flat: boolean, belly = false, water = false) {
    if (this.touchdown.firstContact || !this.wasAirborne) return;
    this.touchdown.firstContact = this.time;
    this.touchdown.vs = vn / FT * 60;
    this.touchdown.site = water ? 'water' : flat ? 'runway' : 'field';
    this.touchdown.g = this.nz;
    this.ev.emit('touchdown', { vs: this.touchdown.vs, site: this.touchdown.site, belly });
  }

  breakWing(side: number, cause = '') {
    const i = side < 0 ? 0 : 1;
    if (this.sys.wingLost[i] || this.sys.invincible) return;
    this.sys.wingLost[i] = 1;
    this.sys.wingLeak[i] = true;
    this.ev.emit('wingBreak', { side, cause });
  }
  repairWings() { this.sys.wingLost = [0, 0]; this.sys.wingLeak = [false, false]; this.ev.emit('wingRepair'); }
  collapseGear(idx: number) {
    if (this.sys.gearCollapsed[idx]) return;
    this.sys.gearCollapsed[idx] = true;
    this.ev.emit('gearCollapse', idx);
  }
  damageEngine(i: number, amount: number) {
    const e = this.engines[i]; if (!e || e.failed) return;
    e.damaged = Math.min(1, e.damaged + amount);
    if (e.damaged >= 0.9) { e.failed = true; this.ev.emit('engineFailed', i); }
  }
  crash(reason: string) {
    if (this.crashed || this.sys.invincible) return;
    this.crashed = true; this.crashReason = reason;
    this.ev.emit('crash', reason);
  }

  // ------------------------------------------------------------ utilities for UI/game
  /** best-glide ratio in current configuration (for the glide ring) */
  glideRatio(): number {
    const t = this.t, cfg = this.flapCfg();
    const AR = t.b * t.b / t.S, k = 1 / (Math.PI * t.e * AR);
    let cd0 = t.CD0 + cfg.dCD + 0.017 * this.gearPos + this.spoilerPos * 0.07 + this.sys.wingLost.reduce((a, b) => a + b, 0) * 0.03;
    for (const e of this.engines) if (e.failed || e.out) cd0 += t.kind === 'jet' ? 0.0012 : 0.002;
    return 1 / (2 * Math.sqrt(cd0 * k)) * (1 - 0.25 * this.sys.wingLost.reduce((a, b) => a + b, 0));
  }
  /** stall speed (kt IAS) at current weight/config/load factor */
  vs1g(nz = 1): number {
    const cfg = this.flapCfg();
    const CLmax = this.t.CLmax + cfg.dCLmax;
    return Math.sqrt(2 * this.mass * G * Math.max(nz, 0.5) / (1.225 * this.t.S * CLmax)) / KT;
  }
  vref(): number {
    const f = this.t.flaps.length - 1;
    const CLmax = this.t.CLmax + this.t.flaps[f].dCLmax;
    return 1.23 * Math.sqrt(2 * this.mass * G / (1.225 * this.t.S * CLmax)) / KT;
  }
  get allEnginesOut() { return this.engines.every(e => e.failed || e.out || e.extinguished); }
  get anyEngineOut() { return this.engines.some(e => e.failed || e.out || e.extinguished); }
  forward(out = new THREE.Vector3()) { return out.set(0, 0, -1).applyQuaternion(this.q); }
}
