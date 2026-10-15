// Touch controls: virtual joystick or tilt (DeviceOrientation), rudder slider, cockpit lever overlay.
import { store } from '../core/store';
import { clamp } from '../core/geo';
import type { Aircraft } from '../sim/flight';

const el = (tag: string, cls = '', html = '') => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

function drag(target: HTMLElement, on: (x: number, y: number, phase: 'start' | 'move' | 'end') => void) {
  let id: number | null = null;
  target.addEventListener('pointerdown', e => { id = e.pointerId; target.setPointerCapture(e.pointerId); on(e.clientX, e.clientY, 'start'); e.preventDefault(); });
  target.addEventListener('pointermove', e => { if (e.pointerId === id) { on(e.clientX, e.clientY, 'move'); e.preventDefault(); } });
  const end = (e: PointerEvent) => { if (e.pointerId === id) { id = null; on(e.clientX, e.clientY, 'end'); } };
  target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
}

export class Controls {
  root = el('div', 'hud-layer');
  stickX = 0; stickY = 0; rudder = 0;
  private tilt = { beta: 0, gamma: 0, ok: false };
  private stick!: HTMLElement; private knob!: HTMLElement;
  private rud!: HTMLElement; private rudKnob!: HTMLElement;
  private thr!: HTMLElement; private thrHandles: HTMLElement[] = [];
  private flap!: HTMLElement; private flapHandle!: HTMLElement; private flapTicks!: HTMLElement;
  private spd!: HTMLElement; private spdHandle!: HTMLElement;
  private gear!: HTMLElement; private gearHandle!: HTMLElement;
  private btns: Record<string, HTMLButtonElement> = {};
  private ac: Aircraft | null = null;
  private split = false;
  onFireHandle: (i: number) => void = () => {};

  constructor(host: HTMLElement) {
    host.appendChild(this.root);
    this.build();
    addEventListener('deviceorientation', ev => {
      const e = ev as DeviceOrientationEvent;
      if (e.beta == null || e.gamma == null) return;
      this.tilt.beta = e.beta; this.tilt.gamma = e.gamma; this.tilt.ok = true;
    });
  }

  static async requestTilt(): Promise<boolean> {
    const D = (window as any).DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      try { return (await D.requestPermission()) === 'granted'; } catch { return false; }
    }
    return 'DeviceOrientationEvent' in window;
  }
  calibrate() { if (this.tilt.ok) store.set('tiltCal', { beta: this.tilt.beta, gamma: this.tilt.gamma }); }

  private build() {
    // joystick
    this.stick = el('div', 'stick ia'); this.knob = el('div', 'knob'); this.stick.appendChild(this.knob);
    drag(this.stick, (x, y, ph) => {
      if (ph === 'end') { this.stickX = 0; this.stickY = 0; }
      else {
        const r = this.stick.getBoundingClientRect();
        const dx = (x - (r.left + r.width / 2)) / (r.width / 2), dy = (y - (r.top + r.height / 2)) / (r.height / 2);
        const m = Math.hypot(dx, dy), k = m > 1 ? 1 / m : 1;
        this.stickX = dx * k; this.stickY = dy * k;
      }
      this.knob.style.transform = `translate(${this.stickX * 46}px, ${this.stickY * 46}px)`;
    });
    // rudder
    this.rud = el('div', 'rudder ia', '<div class="lbl">DÜMEN</div>'); this.rudKnob = el('div', 'knob'); this.rud.appendChild(this.rudKnob);
    drag(this.rud, (x, _y, ph) => {
      if (ph === 'end') this.rudder = 0;
      else { const r = this.rud.getBoundingClientRect(); this.rudder = clamp((x - (r.left + r.width / 2)) / (r.width / 2 - 15), -1, 1); }
      this.rudKnob.style.transform = `translateX(${this.rudder * 48}px)`;
    });
    // levers
    const levers = el('div', 'levers');
    const col = el('div', 'btncol');
    const mk = (k: string, label: string, cls = '') => { const b = el('button', 'cbtn ia ' + cls, label) as HTMLButtonElement; this.btns[k] = b; return b; };
    col.append(mk('trimUp', 'TRIM ▲'), mk('trimDn', 'TRIM ▼'), mk('rev', 'REV'), mk('brk', 'FREN', 'red'), mk('park', 'PARK'));
    this.spd = el('div', 'lever ia', '<div class="lbl">SPOILER</div><div class="track"></div><div class="ticks"><span>RET</span><span>ARM</span><span>½</span><span>FULL</span></div>');
    this.spdHandle = el('div', 'handle', 'SPD'); this.spd.appendChild(this.spdHandle);
    this.flap = el('div', 'lever ia', '<div class="lbl">FLAP</div><div class="track"></div>');
    this.flapTicks = el('div', 'ticks'); this.flap.appendChild(this.flapTicks);
    this.flapHandle = el('div', 'handle', '0'); this.flap.appendChild(this.flapHandle);
    this.gear = el('div', 'lever gear ia', '<div class="lbl">GEAR</div><div class="track"></div><div class="ticks"><span>UP</span><span></span><span>DN</span></div>');
    this.gear.style.width = '50px'; this.gear.style.height = '120px';
    this.gearHandle = el('div', 'handle'); this.gear.appendChild(this.gearHandle);
    this.thr = el('div', 'lever thr ia', '<div class="lbl">GAZ</div><div class="track"></div><div class="ticks"><span>TOGA</span><span>CL</span><span></span><span>IDLE</span></div>');
    levers.append(col, this.spd, this.flap, this.gear, this.thr);
    this.root.append(this.stick, this.rud, levers);

    // lever interactions
    drag(this.thr, (_x, y, ph) => {
      if (!this.ac || ph === 'end') return;
      const r = this.thr.getBoundingClientRect();
      const v = clamp(1 - (y - r.top - 15) / (r.height - 30), 0, 1);
      if (this.split) {
        // split handles: left half moves left engines, right half right engines
        const n = this.ac.ctl.throttle.length;
        const lastX = (this as any)._lastX ?? 0;
        const left = lastX < r.left + r.width / 2;
        for (let i = 0; i < n; i++) if ((i < n / 2) === left) this.ac.ctl.throttle[i] = v;
      } else this.ac.ctl.throttle.fill(v);
    });
    this.thr.addEventListener('pointerdown', e => { (this as any)._lastX = e.clientX; });
    this.thr.addEventListener('dblclick', () => { this.split = !this.split; });
    drag(this.flap, (_x, y, ph) => {
      if (!this.ac || ph === 'end') return;
      const r = this.flap.getBoundingClientRect(), n = this.ac.flapCount;
      this.ac.ctl.flapIdx = clamp(Math.round((y - r.top - 15) / (r.height - 30) * (n - 1)), 0, n - 1);
    });
    drag(this.spd, (_x, y, ph) => {
      if (!this.ac || ph === 'end') return;
      const r = this.spd.getBoundingClientRect();
      const v = clamp((y - r.top - 15) / (r.height - 30), 0, 1);
      if (v < 0.17) { this.ac.ctl.spoiler = 0; this.ac.ctl.spoilerArmed = false; }
      else if (v < 0.4) { this.ac.ctl.spoiler = 0; this.ac.ctl.spoilerArmed = true; }
      else { this.ac.ctl.spoiler = (v - 0.4) / 0.6; this.ac.ctl.spoilerArmed = false; }
    });
    this.gear.addEventListener('pointerdown', e => { if (this.ac) this.ac.ctl.gearDown = !this.ac.ctl.gearDown; e.preventDefault(); });
    const hold = (b: HTMLButtonElement, on: () => void, off: () => void) => {
      b.addEventListener('pointerdown', e => { on(); b.classList.add('on'); e.preventDefault(); });
      const up = () => { off(); b.classList.remove('on'); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
    };
    let trimDir = 0;
    hold(this.btns.trimUp, () => trimDir = 1, () => trimDir = 0);
    hold(this.btns.trimDn, () => trimDir = -1, () => trimDir = 0);
    (this as any).trimDir = () => trimDir;
    hold(this.btns.brk, () => { if (this.ac) this.ac.ctl.brakes = 1; }, () => { if (this.ac) this.ac.ctl.brakes = 0; });
    this.btns.rev.addEventListener('pointerdown', e => { if (this.ac) this.ac.ctl.reverse = !this.ac.ctl.reverse; e.preventDefault(); });
    this.btns.park.addEventListener('pointerdown', e => { if (this.ac) this.ac.ctl.parkBrake = !this.ac.ctl.parkBrake; e.preventDefault(); });
  }

  attach(ac: Aircraft) {
    this.ac = ac;
    const n = ac.flapCount;
    this.flapTicks.innerHTML = ac.t.flaps.map(f => `<span>${f.name}</span>`).join('');
    this.split = false;
    this.thr.querySelectorAll('.handle').forEach(h => h.remove());
    this.thrHandles = [];
    const h = el('div', 'handle'); this.thr.appendChild(h); this.thrHandles.push(h);
    void n;
  }
  setVisible(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  /** called each frame: writes pilot inputs into aircraft controls */
  update(dt: number) {
    const ac = this.ac; if (!ac) return;
    const s = store.settings;
    let px = this.stickX, py = this.stickY;
    if (s.control === 'tilt' && this.tilt.ok) {
      const cal = s.tiltCal ?? { beta: 0, gamma: -40 };
      // landscape: device beta ↔ roll, gamma ↔ pitch (sign depends on orientation)
      const o = (screen.orientation?.angle ?? (window as any).orientation ?? 90) as number;
      const sg = o === 270 || o === -90 ? -1 : 1;
      const roll = clamp((this.tilt.beta - cal.beta) * sg / 28, -1, 1);
      const pitch = clamp(-(this.tilt.gamma - cal.gamma) * sg / 22, -1, 1);
      px = Math.abs(roll) < 0.04 ? 0 : roll;
      py = Math.abs(pitch) < 0.04 ? 0 : pitch;
      this.stick.style.opacity = '0.25';
    } else this.stick.style.opacity = '1';
    const sens = s.control === 'tilt' ? s.tiltSens : s.stickSens;
    const curve = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.6) * sens;
    ac.ctl.roll = clamp(curve(px), -1, 1);
    ac.ctl.pitch = clamp(curve(s.invertPitch ? -py : py), -1, 1); // pull (down on stick) = nose up
    ac.ctl.yaw = this.rudder;
    const td = (this as any).trimDir?.() ?? 0;
    if (td) ac.ctl.trim = clamp(ac.ctl.trim + td * dt * 0.12, -1, 1);
    // reflect lever states
    const thr = ac.ctl.throttle.reduce((a, b) => a + b, 0) / ac.ctl.throttle.length;
    const H = this.thr.clientHeight - 30;
    this.thrHandles[0].style.top = `${(1 - thr) * H}px`;
    this.thrHandles[0].textContent = ac.ctl.reverse ? 'REV' : `${Math.round(thr * 100)}`;
    const n = ac.flapCount;
    this.flapHandle.style.top = `${ac.ctl.flapIdx / (n - 1) * (this.flap.clientHeight - 30)}px`;
    this.flapHandle.textContent = ac.t.flaps[ac.ctl.flapIdx].name;
    const sv = ac.ctl.spoilerArmed ? 0.28 : ac.ctl.spoiler > 0 ? 0.4 + ac.ctl.spoiler * 0.6 : 0;
    this.spdHandle.style.top = `${sv * (this.spd.clientHeight - 30)}px`;
    this.spdHandle.textContent = ac.ctl.spoilerArmed ? 'ARM' : ac.ctl.spoiler > 0 ? Math.round(ac.ctl.spoiler * 100) + '' : 'RET';
    this.gearHandle.style.top = ac.ctl.gearDown ? `${this.gear.clientHeight - 46}px` : '10px';
    this.gearHandle.style.background = ac.gearPos > 0.99 ? 'radial-gradient(circle at 40% 35%, #b8ffc8, #3c9)' : ac.gearPos > 0.01 ? 'radial-gradient(circle at 40% 35%, #ffd0d0, #e44)' : '';
    this.btns.rev.classList.toggle('on', ac.ctl.reverse);
    this.btns.park.classList.toggle('on', ac.ctl.parkBrake);
    this.rud.style.display = '';
  }
}
