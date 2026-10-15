// Dev-only test helpers (not included in production builds).
import { typeById } from './sim/aircraftData';
import { SCENARIOS } from './game/scenarios';

const w = window as any;
w.__T = typeById;
w.__SC = SCENARIOS;

/** drop the aircraft onto runway end 0 of `apt` from hAgl metres with vertical speed vsMs, then brake */
w.__drop = async (type = 'a320', apt = 'LTBA', vsMs = -2, hAgl = 3) => {
  await w.__start({ mode: 'free', type: typeById(type), weather: { hour: 13, windKt: 0 }, start: { kind: 'runway', apt, end: 0 }, pax: 150, engineFail: 'none' });
  const g = w.__game, a = g.ac; const r = g.world.db.byId.get(apt).runways[0]; const e = r.ends[0];
  a.ctl.gearDown = true; a.ctl.flapIdx = a.flapCount - 1; a.flapPos = a.ctl.flapIdx; a.ctl.spoilerArmed = true;
  const x = e.x + r.dirx * 500, z = e.z + r.dirz * 500; const vr = a.vref() * 0.5144;
  a.place(x, r.elev + a.t.gearH + hAgl, z, e.hdg, vr, 3, false); a.vel.y = vsMs; a.wasAirborne = true; a.ctl.throttle.fill(0.3);
  w.__td = null; w.__done = null; w.__ev = [];
  const t0 = performance.now();
  clearInterval(w.__iv);
  w.__iv = setInterval(() => {
    const t = (performance.now() - t0) / 1000;
    if (a.onGround) { a.ctl.throttle.fill(0); a.ctl.brakes = a.gs > 3 ? 1 : 0; a.ctl.reverse = a.gs > 60; if (a.ctl.reverse) a.ctl.throttle.fill(0.7); }
    if (a.touchdown.firstContact && !w.__td) w.__td = { vs: a.touchdown.vs.toFixed(0), site: a.touchdown.site, t: t.toFixed(1) };
    if (t > 60 || a.crashed || (a.stopped && a.onGround)) { clearInterval(w.__iv); w.__done = { crash: a.crashReason, stopped: a.stopped, collapsed: a.sys.gearCollapsed, wing: a.sys.wingLost, t: t.toFixed(1), dist: Math.hypot(a.pos.x - x, a.pos.z - z).toFixed(0) }; }
  }, 100);
  return 'ok';
};

/** start an emergency scenario by id */
w.__scen = async (id: string, fail?: string) => {
  const s = SCENARIOS.find(x => x.id === id)!;
  const t = typeById(s.aircraft);
  await w.__start({ mode: 'emergency', type: t, weather: s.weather ?? {}, scenario: s, engineFail: fail ?? s.engines, start: w.__screens.scenarioStart(s, t), pax: Math.round(t.seats * 0.9) || 6, fuelKg: s.fuelKg });
  return 'ok';
};
w.__state = () => {
  const a = w.__game.ac; if (!a) return null;
  return { ias: +a.ias.toFixed(0), ft: +(a.alt / 0.3048).toFixed(0), ra: +(a.ra / 0.3048).toFixed(0), vs: +a.vs.toFixed(0), pitch: +a.pitch.toFixed(1), bank: +a.bank.toFixed(1), hdg: +a.hdg.toFixed(0), alpha: +(a.alpha * 57.3).toFixed(1), onG: a.onGround, water: a.inWater, crashed: a.crashReason, fps: w.__game.renderer.info.render.calls };
};

/** ditching test: place at hAgl above water near LTBG scenario point */
w.__ditch = async (kt = 140, vsMs = -1.5, pitch = 6, gear = false) => {
  await w.__scen('gecedeniz');
  const a = w.__game.ac;
  const tas = kt * 0.5144;
  a.place(a.pos.x, 6 + a.t.dia / 2 + 1, a.pos.z, a.hdg, tas, pitch, false); a.vel.y = vsMs; a.wasAirborne = true;
  a.ctl.gearDown = gear; a.gearPos = gear ? 1 : 0; a.ctl.flapIdx = a.flapCount - 1; a.flapPos = a.ctl.flapIdx;
  w.__done = null; clearInterval(w.__iv); const t0 = performance.now();
  w.__iv = setInterval(() => { const t = (performance.now() - t0) / 1000; w.__game.controls.stickY = a.inWater ? 0 : 0.05;
    if (t > 60 || a.crashed || a.stopped) { clearInterval(w.__iv); w.__done = { crash: a.crashReason, stopped: a.stopped, decel: a.peakDecel.toFixed(2), td: a.touchdown, t: t.toFixed(1) }; } }, 100);
  return 'ok';
};
