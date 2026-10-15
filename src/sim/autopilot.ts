// Autopilot + autothrottle: HDG / ALT / V/S hold, speed hold, ILS approach (LOC + G/S capture).
// Outer loops write ac.ctl.roll / ac.ctl.pitch / throttles, so it works through FBW normal law as well as
// direct-law aircraft. Disconnects on strong pilot input, failures, stall, or at minimums on an approach.
import type { Aircraft } from './flight';
import type { IlsState } from '../ui/hud';
import { clamp, wrap180, FT } from '../core/geo';

export type Lat = 'HDG' | 'LOC';
export type Vert = 'ALT' | 'VS' | 'GS';

export class Autopilot {
  on = false; athr = false; app = false;
  lat: Lat = 'HDG'; vert: Vert = 'ALT';
  hdg = 0; alt = 3000; spd = 200; vs = 0;
  locCap = false; gsCap = false;
  onEvent: (msg: string, warn: boolean) => void = () => {};
  private pI = 0; private tI = 0; private lastBank = 0; private lastVs = 0; private vsAcc = 0; private lastIas = 0; private iasTrend = 0;

  available(ac: Aircraft) {
    return ac.sys.electrics && ac.sys.hydraulics && ac.law !== 'direct' || (!ac.t.fbw && ac.sys.hydraulics && ac.sys.electrics);
  }
  engage(ac: Aircraft) {
    if (!this.available(ac)) { this.onEvent('Otopilot kullanılamıyor (sistem arızası)', true); return; }
    if (ac.onGround) { this.onEvent('Otopilot yerde devreye alınamaz', true); return; }
    this.on = true; this.lat = 'HDG'; this.vert = 'ALT';
    this.hdg = Math.round(ac.hdg); this.alt = Math.max(1000, Math.round(ac.alt / FT / 100) * 100); this.vs = 0;
    this.pI = 0; this.lastBank = ac.bank; this.lastVs = ac.vs;
    this.locCap = this.gsCap = false;
    this.onEvent('AP1 devrede', false);
  }
  engageAthr(ac: Aircraft) {
    if (!ac.sys.electrics) { this.onEvent('A/THR kullanılamıyor', true); return; }
    this.athr = true; this.spd = Math.round(ac.ias);
    this.tI = ac.ctl.throttle.reduce((a, b) => a + b, 0) / ac.ctl.throttle.length;
    this.lastIas = ac.ias; this.iasTrend = 0;
    this.onEvent('A/THR devrede', false);
  }
  disconnect(why = '', warn = true) { if (!this.on) return; this.on = false; this.app = false; this.onEvent('AP OFF' + (why ? ' · ' + why : ''), warn); }
  disconnectAthr(why = '') { if (!this.athr) return; this.athr = false; this.onEvent('A/THR OFF' + (why ? ' · ' + why : ''), true); }
  reset() { this.on = this.athr = this.app = false; this.locCap = this.gsCap = false; }

  /** FMA text for the PFD */
  fma() {
    if (!this.on && !this.athr) return '';
    const v = this.vert === 'GS' ? 'G/S' : this.vert === 'VS' ? `V/S ${this.vs > 0 ? '+' : ''}${this.vs}` : 'ALT';
    const l = this.lat === 'LOC' ? 'LOC' : 'HDG';
    const arm = this.app ? `${this.locCap ? '' : ' LOC*'}${this.gsCap ? '' : ' G/S*'}` : '';
    return `${this.athr ? 'SPEED' : '     '}  ${this.on ? `${v}  ${l}${arm}  AP1` : ''}`.trim();
  }

  /** call once per frame after pilot inputs were written */
  update(ac: Aircraft, dt: number, ils: IlsState | null) {
    if (dt <= 0) return;
    const ra = ac.ra / FT;
    if (this.on) {
      if (!this.available(ac)) this.disconnect('sistem arızası');
      else if (ac.onGround) this.disconnect('', false);
      else if (Math.abs(ac.ctl.roll) > 0.45 || Math.abs(ac.ctl.pitch) > 0.45) this.disconnect('pilot müdahalesi');
      else if (ac.stall > 0.5) this.disconnect('stall');
      else if (Math.abs(ac.bank) > 45) this.disconnect('aşırı yatış');
    }
    if (this.athr && (ac.onGround || !ac.sys.electrics)) this.disconnectAthr();
    if (this.on) this.fly(ac, dt, ils, ra);
    if (this.athr) this.thrust(ac, dt, ra);
  }

  private fly(ac: Aircraft, dt: number, ils: IlsState | null, ra: number) {
    // ---- approach mode: LOC then G/S capture
    if (this.app && ils) {
      const rwHdg = ils.rw.ends[ils.end].hdg;
      if (!this.locCap && Math.abs(ils.loc) < 1.8 && Math.abs(wrap180(ac.hdg - rwHdg)) < 60) { this.locCap = true; this.lat = 'LOC'; this.onEvent('LOC yakalandı', false); }
      if (this.locCap && !this.gsCap && ils.gs > -0.6 && ils.gs < 1.2) { this.gsCap = true; this.vert = 'GS'; this.onEvent('G/S yakalandı', false); }
      if (this.gsCap && ra < 80) { this.disconnect('MİNİMUM — elle iniş', true); return; }
    }
    if (this.app && !ils && (this.locCap || this.gsCap)) { this.locCap = this.gsCap = false; this.lat = 'HDG'; this.vert = 'ALT'; this.hdg = Math.round(ac.hdg); this.alt = Math.round(ac.alt / FT / 100) * 100; this.onEvent('ILS kaybedildi', true); }

    // ---- lateral
    let trkT = this.hdg;
    if (this.lat === 'LOC' && ils) {
      const rwHdg = ils.rw.ends[ils.end].hdg;
      // loc > 0 = right of centreline (dots); steer back, stronger close in
      const k = clamp(ils.dist / 9000, 0.35, 1.2);
      trkT = rwHdg - clamp(ils.loc * 14 / k, -30, 30);
    }
    const ref = this.lat === 'LOC' ? ac.trk : ac.hdg;
    const bankT = clamp(wrap180(trkT - ref) * 1.6, this.lat === 'LOC' ? -20 : -25, this.lat === 'LOC' ? 20 : 25);
    const bankRate = (ac.bank - this.lastBank) / dt; this.lastBank = ac.bank;
    ac.ctl.roll = clamp((bankT - ac.bank) * 0.045 - bankRate * 0.03, -0.6, 0.6);
    ac.ctl.yaw = 0;

    // ---- vertical
    const altFt = ac.alt / FT;
    let vsT: number;
    if (this.vert === 'GS' && ils) vsT = clamp(-ac.gs * 5.3 - ils.gs * 280, -1600, 200);
    else if (this.vert === 'VS') {
      vsT = this.vs;
      if ((this.vs > 0 && altFt > this.alt - 150) || (this.vs < 0 && altFt < this.alt + 150)) { this.vert = 'ALT'; this.onEvent('ALT yakalandı', false); }
    } else vsT = clamp((this.alt - altFt) * 2.2, -2000, 2000);
    // don't climb/descend into a stall or overspeed when the A/THR can't help
    const vls = ac.vs1g() * 1.25;
    if (ac.ias < vls && vsT > 0) vsT = Math.min(vsT, (ac.ias - vls * 0.95) * 60);
    this.vsAcc += ((ac.vs - this.lastVs) / dt - this.vsAcc) * Math.min(1, dt * 6); this.lastVs = ac.vs;
    const vsAcc = this.vsAcc;
    const err = (vsT - ac.vs) / 1000;
    const fbw = ac.law === 'normal';
    this.pI = clamp(this.pI + err * dt * (fbw ? 0.06 : 0.12), -0.5, 0.5);
    ac.ctl.pitch = clamp(err * (fbw ? 0.2 : 0.22) + this.pI - vsAcc / 1000 * (fbw ? 0.35 : 0.35), -0.45, 0.45);
  }

  private thrust(ac: Aircraft, dt: number, ra: number) {
    if (this.vert === 'GS' && ra < 30 && this.gsCap) { ac.ctl.throttle.fill(0); this.tI = 0; this.onEvent('RETARD', false); this.athr = false; return; }
    // speed trend (kt/s), filtered — lead term like the real A/THR
    this.iasTrend += ((ac.ias - this.lastIas) / dt - this.iasTrend) * Math.min(1, dt * 2); this.lastIas = ac.ias;
    const vls = ac.vs1g() * 1.25; // VLS for the current configuration
    const tgt = Math.max(this.spd, vls);
    const err = clamp(tgt - ac.ias - this.iasTrend * 4, -15, 15);
    this.tI = clamp(this.tI + err * dt * 0.01, 0.05, 1);
    const cmd = clamp(this.tI + err * 0.03, 0, 1);
    // levers move at a limited rate — avoids pitch/thrust coupling
    for (let i = 0; i < ac.ctl.throttle.length; i++) ac.ctl.throttle[i] = clamp(cmd, ac.ctl.throttle[i] - 0.2 * dt, ac.ctl.throttle[i] + 0.2 * dt);
    ac.ctl.reverse = false;
  }
}
