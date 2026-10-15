// Glass cockpit: PFD (speed tape w/ stall + overspeed bands, attitude, altitude, VS, heading, ILS) and
// ND (heading-up map with real runways, airports, glide-range ring, wind), warnings + engine strip.
import type { Aircraft } from '../sim/flight';
import type { World } from '../world/world';
import { ilsDeviation, Runway } from '../world/airports';
import { FT, NM, KT, wrap180, clamp, DEG } from '../core/geo';
import { store } from '../core/store';

export interface IlsState { rw: Runway; end: 0 | 1; loc: number; gs: number; dist: number; ident: string; apt: string }

export class Hud {
  pfd = document.createElement('canvas');
  nd = document.createElement('canvas');
  eng = document.createElement('canvas');
  root = document.createElement('div');
  ndRange = 20; // NM
  ils: IlsState | null = null;
  target: { lat: number; lon: number; name: string } | null = null;
  glideRing = false;
  fma = ''; fmaSel = '';
  private dpr = Math.min(2, devicePixelRatio || 1);
  private frame = 0;
  constructor(host: HTMLElement) {
    this.root.className = 'hud-layer';
    for (const c of [this.pfd, this.nd, this.eng]) { c.className = 'inst ia'; this.root.appendChild(c); }
    host.appendChild(this.root);
    this.nd.addEventListener('pointerdown', () => { const r = [5, 10, 20, 40, 80, 160]; this.ndRange = r[(r.indexOf(this.ndRange) + 1) % r.length]; });
    this.layout();
    addEventListener('resize', () => this.layout());
  }
  /** fit PFD + ND (+ engine strip) into the free strip between the touch stick (left) and the levers (right) */
  layout() {
    const s = store.settings.hudScale;
    const W = innerWidth, H = innerHeight;
    const vis = (sel: string) => { const e = document.querySelector<HTMLElement>(sel); const r = e?.getBoundingClientRect(); return r && r.width > 0 && e!.offsetParent !== null ? r : null; };
    const stick = vis('.stick'), rud = vis('.rudder'), lev = vis('.levers');
    let left = 8, right = W - 8;
    if (stick) left = Math.max(left, stick.right + 6);
    if (rud && rud.bottom > H - 200) left = Math.max(left, rud.right + 6);
    if (lev) right = Math.min(right, lev.left - 6);
    if (right - left < 260) { left = 8; right = lev ? lev.left - 6 : W - 8; } // controls hidden (HUD toggle) or tiny screen
    const avail = right - left;
    let size = Math.round(Math.min(190, H * 0.46) * s);
    const engBeside = avail >= size * 2.18 + 8 + size * 0.62 + 10;
    size = Math.max(90, Math.min(size, Math.floor((avail - 8) / 2.18)));
    const pw = Math.round(size * 1.18), mid = Math.round(left + (avail - (engBeside ? size * 0.62 + 10 : 0)) / 2);
    const set = (c: HTMLCanvasElement, w: number, h: number, l: number) => {
      c.style.width = w + 'px'; c.style.height = h + 'px'; c.style.left = l + 'px';
      c.width = Math.round(w * this.dpr); c.height = Math.round(h * this.dpr);
    };
    set(this.pfd, pw, size, mid - pw - 4);
    set(this.nd, size, size, mid + 4);
    const es = Math.round(size * (engBeside ? 0.62 : 0.56));
    set(this.eng, es, es, engBeside ? mid + size + 10 : W - es - 44);
    if (engBeside) { this.eng.style.bottom = `calc(6px + var(--sab))`; this.eng.style.top = ''; this.eng.style.right = ''; }
    else { this.eng.style.bottom = 'auto'; this.eng.style.top = `calc(6px + var(--sat))`; this.eng.style.left = ''; this.eng.style.right = `calc(44px + var(--sar))`; }
  }
  setVisible(v: boolean) { this.root.style.display = v ? '' : 'none'; }

  update(ac: Aircraft, world: World) {
    this.frame++;
    if (this.frame % 2) return; // 30 Hz
    this.findIls(ac, world);
    if (ac.sys.electrics) { this.drawPFD(ac); this.drawND(ac, world); this.nd.style.display = ''; }
    else { this.drawStandby(ac); this.nd.style.display = 'none'; }
    this.drawEng(ac);
  }

  private findIls(ac: Aircraft, world: World) {
    if (this.frame % 20 !== 0 && this.ils) {
      const d = ilsDeviation(this.ils.rw, this.ils.end, ac.pos.x, ac.pos.y, ac.pos.z);
      Object.assign(this.ils, d);
      if (!d.valid) this.ils = null;
      return;
    }
    let best: IlsState | null = null, bestScore = 1e9;
    for (const a of world.active.values()) for (const rw of a.runways) for (const end of [0, 1] as const) {
      if (!rw.ends[end].ils) continue;
      const d = ilsDeviation(rw, end, ac.pos.x, ac.pos.y, ac.pos.z);
      if (!d.valid) continue;
      const hdgDiff = Math.abs(wrap180(ac.hdg - rw.ends[end].hdg));
      if (hdgDiff > 45) continue;
      const score = Math.abs(d.loc) * 3000 + d.dist * 0.2 + hdgDiff * 100;
      if (score < bestScore) { bestScore = score; best = { rw, end, ...d, ident: rw.ends[end].ident, apt: a.ident }; }
    }
    this.ils = best;
  }

  private ctx(c: HTMLCanvasElement) { const g = c.getContext('2d')!; g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); return g; }

  private drawPFD(ac: Aircraft) {
    const g = this.ctx(this.pfd), W = this.pfd.width / this.dpr, H = this.pfd.height / this.dpr;
    g.clearRect(0, 0, W, H);
    const cx = W * 0.5, cy = H * 0.47, R = H * 0.34;
    // ---- attitude
    g.save();
    g.beginPath(); g.rect(cx - R, cy - R, R * 2, R * 2); g.clip();
    g.translate(cx, cy); g.rotate(-ac.bank * DEG);
    const ppd = R / 22; // px per degree
    const py = ac.pitch * ppd;
    g.fillStyle = '#2b78c5'; g.fillRect(-R * 3, -R * 3 + py, R * 6, R * 3);
    g.fillStyle = '#7a4b22'; g.fillRect(-R * 3, py, R * 6, R * 3);
    g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-R * 3, py); g.lineTo(R * 3, py); g.stroke();
    g.font = `${Math.round(H * 0.05)}px sans-serif`; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let a = -30; a <= 30; a += 2.5) {
      if (a === 0) continue;
      const y = py - a * ppd, w = a % 10 === 0 ? R * 0.42 : a % 5 === 0 ? R * 0.22 : R * 0.1;
      g.beginPath(); g.moveTo(-w / 2, y); g.lineTo(w / 2, y); g.stroke();
      if (a % 10 === 0) { g.fillText(String(Math.abs(a)), -w / 2 - 10, y); g.fillText(String(Math.abs(a)), w / 2 + 10, y); }
    }
    g.restore();
    // bank scale
    g.save(); g.translate(cx, cy); g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
      const r0 = R * 0.98, r1 = R * (a % 30 === 0 ? 0.86 : 0.91);
      const t = (a - 90) * DEG;
      g.beginPath(); g.moveTo(Math.cos(t) * r0, Math.sin(t) * r0); g.lineTo(Math.cos(t) * r1, Math.sin(t) * r1); g.stroke();
    }
    g.rotate(-ac.bank * DEG); g.fillStyle = Math.abs(ac.bank) > 35 ? '#ffb000' : '#fff';
    g.beginPath(); g.moveTo(0, -R * 0.84); g.lineTo(-6, -R * 0.74); g.lineTo(6, -R * 0.74); g.closePath(); g.fill();
    g.restore();
    // aircraft symbol + flight path vector
    g.strokeStyle = '#ffd400'; g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx - R * 0.55, cy); g.lineTo(cx - R * 0.2, cy); g.lineTo(cx - R * 0.2, cy + 6); g.moveTo(cx + R * 0.55, cy); g.lineTo(cx + R * 0.2, cy); g.lineTo(cx + R * 0.2, cy + 6); g.stroke();
    g.fillStyle = '#ffd400'; g.fillRect(cx - 3, cy - 3, 6, 6);
    if (ac.tas > 20) {
      const fpa = Math.atan2(ac.vel.y, Math.hypot(ac.vel.x, ac.vel.z)) / DEG;
      const drift = wrap180(ac.trk - ac.hdg);
      const fx = cx + clamp(drift, -15, 15) * ppd, fy = cy - (fpa - ac.pitch) * ppd;
      g.strokeStyle = '#3cf27a'; g.lineWidth = 2; g.beginPath(); g.arc(fx, fy, 5, 0, Math.PI * 2);
      g.moveTo(fx - 12, fy); g.lineTo(fx - 5, fy); g.moveTo(fx + 5, fy); g.lineTo(fx + 12, fy); g.moveTo(fx, fy - 5); g.lineTo(fx, fy - 10); g.stroke();
    }
    // ILS deviation
    if (this.ils) {
      g.fillStyle = '#ff4fd8'; g.strokeStyle = '#fff'; g.lineWidth = 1;
      const lx = cx + this.ils.loc * R * 0.32, gy = cy + this.ils.gs * R * 0.32;
      for (let i = -2; i <= 2; i++) { if (!i) continue; g.beginPath(); g.arc(cx + i * R * 0.32, cy + R * 1.08, 2.5, 0, 7); g.stroke(); g.beginPath(); g.arc(cx + R * 1.08, cy + i * R * 0.32, 2.5, 0, 7); g.stroke(); }
      g.beginPath(); g.moveTo(lx, cy + R * 1.08 - 6); g.lineTo(lx + 6, cy + R * 1.08); g.lineTo(lx, cy + R * 1.08 + 6); g.lineTo(lx - 6, cy + R * 1.08); g.fill();
      g.beginPath(); g.moveTo(cx + R * 1.08 - 6, gy); g.lineTo(cx + R * 1.08, gy - 6); g.lineTo(cx + R * 1.08 + 6, gy); g.lineTo(cx + R * 1.08, gy + 6); g.fill();
      g.font = `${Math.round(H * 0.055)}px monospace`; g.fillStyle = '#ff4fd8'; g.textAlign = 'left';
      g.fillText(`ILS ${this.ils.apt} ${this.ils.ident} ${(this.ils.dist / NM).toFixed(1)}NM`, 4, H * 0.13);
    }
    // ---- speed tape
    const tw = W * 0.17, tx = 2;
    const ias = ac.iasDisplayed;
    g.fillStyle = 'rgba(40,44,52,0.85)'; g.fillRect(tx, cy - R * 1.1, tw, R * 2.2);
    const kpp = R * 2.2 / 80; // px per kt (80 kt visible)
    g.save(); g.beginPath(); g.rect(tx, cy - R * 1.1, tw, R * 2.2); g.clip();
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.font = `${Math.round(H * 0.06)}px monospace`; g.textAlign = 'right';
    for (let s = Math.floor((ias - 45) / 10) * 10; s < ias + 45; s += 10) {
      if (s < 0) continue;
      const y = cy - (s - ias) * kpp;
      g.beginPath(); g.moveTo(tx + tw - 8, y); g.lineTo(tx + tw, y); g.stroke();
      if (s % 20 === 0) g.fillText(String(s), tx + tw - 10, y + 4);
    }
    // stall band (red/black) & overspeed (barber pole) & flap limit
    const vs = ac.vs1g(Math.max(1, ac.nz));
    const vfe = ac.t.flaps[Math.round(ac.flapPos)]?.vfe ?? 999;
    const vmax = Math.min(ac.t.vmo, vfe, ac.gearPos > 0.1 ? 270 : 999);
    const yv = (v: number) => cy - (v - ias) * kpp;
    g.fillStyle = '#e32'; g.fillRect(tx + tw - 6, yv(vs), 6, R * 3);
    g.fillStyle = '#ffb000'; g.fillRect(tx + tw - 6, yv(vs * 1.13), 6, yv(vs) - yv(vs * 1.13));
    for (let y = yv(vmax); y > cy - R * 1.2; y -= 8) { g.fillStyle = '#e32'; g.fillRect(tx + tw - 6, y - 4, 6, 4); g.fillStyle = '#fff'; g.fillRect(tx + tw - 6, y - 8, 6, 4); }
    // vref bug
    if (!ac.onGround) { g.fillStyle = '#3cf27a'; g.fillRect(tx + tw - 14, yv(ac.vref()) - 1, 8, 2); }
    g.restore();
    // speed trend
    g.fillStyle = '#000'; g.fillRect(tx, cy - 11, tw + 4, 22);
    g.strokeStyle = '#ffd400'; g.strokeRect(tx, cy - 11, tw + 4, 22);
    g.fillStyle = ias < vs * 1.1 ? '#ff4040' : '#fff'; g.font = `bold ${Math.round(H * 0.075)}px monospace`; g.textAlign = 'right';
    g.fillText(ac.sys.pitot ? String(Math.round(ias)) : String(Math.round(ias)), tx + tw, cy + 6);
    g.font = `${Math.round(H * 0.05)}px monospace`; g.fillStyle = '#3cf27a'; g.textAlign = 'left';
    g.fillText(ac.mach > 0.4 ? `M.${Math.round(ac.mach * 1000).toString().padStart(3, '0')}` : `GS${Math.round(ac.gs)}`, tx, cy + R * 1.1 + 12);
    // ---- altitude tape
    const ax = W - tw - 26, alt = ac.alt / FT;
    g.fillStyle = 'rgba(40,44,52,0.85)'; g.fillRect(ax, cy - R * 1.1, tw + 4, R * 2.2);
    const fpp = R * 2.2 / 1000;
    g.save(); g.beginPath(); g.rect(ax, cy - R * 1.1, tw + 4, R * 2.2); g.clip();
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.font = `${Math.round(H * 0.055)}px monospace`; g.textAlign = 'left';
    for (let a = Math.floor((alt - 600) / 100) * 100; a < alt + 600; a += 100) {
      const y = cy - (a - alt) * fpp;
      g.beginPath(); g.moveTo(ax, y); g.lineTo(ax + 6, y); g.stroke();
      if (a % 200 === 0) g.fillText(String(a), ax + 8, y + 4);
    }
    // ground (radio alt) band
    const gy0 = cy - ((ac.alt - ac.agl) / FT - alt) * fpp;
    g.fillStyle = 'rgba(200,60,40,0.6)'; g.fillRect(ax, gy0, 8, R * 3);
    g.restore();
    g.fillStyle = '#000'; g.fillRect(ax - 2, cy - 11, tw + 8, 22); g.strokeStyle = '#ffd400'; g.strokeRect(ax - 2, cy - 11, tw + 8, 22);
    g.fillStyle = '#3cf27a'; g.font = `bold ${Math.round(H * 0.07)}px monospace`; g.textAlign = 'left';
    g.fillText(String(Math.round(alt / 10) * 10), ax, cy + 6);
    // VS
    const vsx = W - 22;
    g.fillStyle = 'rgba(40,44,52,0.7)'; g.fillRect(vsx, cy - R, 20, R * 2);
    const vy = clamp(ac.vs / 6000, -1, 1) * R;
    g.strokeStyle = Math.abs(ac.vs) > 2500 && ac.ra < 2500 ? '#ffb000' : '#3cf27a'; g.lineWidth = 2.5;
    g.beginPath(); g.moveTo(vsx + 20, cy); g.lineTo(vsx + 2, cy - vy); g.stroke();
    g.font = `${Math.round(H * 0.045)}px monospace`; g.fillStyle = '#3cf27a'; g.textAlign = 'right';
    if (Math.abs(ac.vs) > 200) g.fillText(String(Math.round(ac.vs / 100) * 100), W - 2, ac.vs > 0 ? cy - R - 4 : cy + R + 12);
    // radio altitude
    if (ac.ra < 2500) { g.fillStyle = ac.ra < 500 ? '#ffb000' : '#3cf27a'; g.font = `bold ${Math.round(H * 0.07)}px monospace`; g.textAlign = 'center'; g.fillText(String(Math.max(0, Math.round(ac.ra / FT / (ac.ra / FT > 50 ? 10 : 1)) * (ac.ra / FT > 50 ? 10 : 1))), cx, cy + R * 0.82); }
    // heading strip
    const hy = H - 14;
    g.fillStyle = 'rgba(40,44,52,0.85)'; g.fillRect(cx - R, hy - 10, R * 2, 20);
    g.save(); g.beginPath(); g.rect(cx - R, hy - 10, R * 2, 20); g.clip();
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.font = `${Math.round(H * 0.05)}px monospace`; g.textAlign = 'center';
    const dpp = R * 2 / 50;
    for (let h = Math.floor(ac.hdg / 5) * 5 - 30; h < ac.hdg + 30; h += 5) {
      const x = cx + wrap180(h - ac.hdg) * dpp;
      g.beginPath(); g.moveTo(x, hy - 10); g.lineTo(x, hy - (h % 10 ? 6 : 3)); g.stroke();
      if (h % 10 === 0) g.fillText(String(((h + 360) % 360) / 10 | 0).padStart(2, '0'), x, hy + 7);
    }
    g.restore();
    g.fillStyle = '#ffd400'; g.fillRect(cx - 1, hy - 12, 2, 10);
    // FMA / law
    g.font = `${Math.round(H * 0.05)}px monospace`; g.textAlign = 'center';
    const law = ac.t.fbw ? (ac.law === 'normal' ? 'NORMAL LAW' : ac.law === 'alternate' ? 'ALTN LAW' : 'DIRECT LAW') : ac.easy ? 'KOLAY ASİST' : 'MANUAL';
    g.fillStyle = ac.law === 'normal' || !ac.t.fbw ? '#3cf27a' : '#ffb000';
    if (this.fma) { g.fillStyle = '#3cf27a'; g.fillText(this.fma, cx, 10); g.fillStyle = '#46d6ff'; g.fillText(this.fmaSel, cx, H - 4 - H * 0.16); }
    else g.fillText(law, cx, 10);
  }

  private drawStandby(ac: Aircraft) {
    const g = this.ctx(this.pfd), W = this.pfd.width / this.dpr, H = this.pfd.height / this.dpr;
    g.clearRect(0, 0, W, H);
    const s = H * 0.7, x0 = (W - s) / 2, y0 = H * 0.12, cx = x0 + s / 2, cy = y0 + s / 2;
    g.fillStyle = '#111'; g.fillRect(x0 - 4, y0 - 4, s + 8, s + 8);
    g.save(); g.beginPath(); g.arc(cx, cy, s * 0.42, 0, 7); g.clip();
    g.translate(cx, cy); g.rotate(-ac.bank * DEG);
    const py = ac.pitch * s / 50;
    g.fillStyle = '#2b78c5'; g.fillRect(-s, -s + py, s * 2, s); g.fillStyle = '#7a4b22'; g.fillRect(-s, py, s * 2, s);
    g.restore();
    g.strokeStyle = '#ffd400'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx - 30, cy); g.lineTo(cx - 8, cy); g.moveTo(cx + 8, cy); g.lineTo(cx + 30, cy); g.stroke();
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(H * 0.08)}px monospace`;
    g.textAlign = 'left'; g.fillText(String(Math.round(ac.iasDisplayed)), 4, cy + 6);
    g.textAlign = 'right'; g.fillText(String(Math.round(ac.alt / FT / 10) * 10), W - 4, cy + 6);
    g.textAlign = 'center'; g.font = `${Math.round(H * 0.055)}px monospace`; g.fillStyle = '#ffb000';
    g.fillText('YEDEK GÖSTERGE — ELEKTRİK ARIZASI', W / 2, H - 8);
    g.fillText(`HDG ${Math.round(ac.hdg).toString().padStart(3, '0')}`, W / 2, y0 - 6);
  }

  private drawND(ac: Aircraft, world: World) {
    const g = this.ctx(this.nd), W = this.nd.width / this.dpr, H = this.nd.height / this.dpr;
    g.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.78, R = H * 0.7;
    const mpp = this.ndRange * NM / R;
    const hr = ac.hdg * DEG, ch = Math.cos(hr), sh = Math.sin(hr);
    const toScreen = (x: number, z: number): [number, number] => {
      const dx = x - ac.pos.x, dn = -(z - ac.pos.z); // east, north
      const rx = dx * ch - dn * sh, ry = dx * sh + dn * ch; // right, forward
      return [cx + rx / mpp, cy - ry / mpp];
    };
    g.save(); g.beginPath(); g.arc(cx, cy, R * 1.05, Math.PI, 0); g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.clip();
    // range arcs
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
    for (const f of [0.5, 1]) { g.beginPath(); g.arc(cx, cy, R * f, Math.PI * 1.05, Math.PI * 1.95); g.stroke(); }
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = `${Math.round(H * 0.05)}px monospace`; g.textAlign = 'left';
    g.fillText(String(this.ndRange / 2), cx + R * 0.5 * 0.71 + 2, cy - R * 0.5 * 0.71);
    // glide range ring
    if (this.glideRing && store.settings.showGlideRing) {
      const gr = ac.glideRatio() * 0.85;
      const range = Math.max(0, ac.agl) * gr; // m (still air)
      const wind = ac.weather.wind(ac.agl);
      const tGlide = range / Math.max(ac.tas, 60);
      const [wx, wy] = toScreen(ac.pos.x + wind.x * tGlide, ac.pos.z + wind.z * tGlide);
      g.strokeStyle = '#3cf27a'; g.setLineDash([6, 4]); g.lineWidth = 2;
      g.beginPath(); g.arc(wx, wy, range / mpp, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#3cf27a'; g.fillText(`SÜZÜLME ${(range / NM).toFixed(1)}NM`, 4, 12);
    }
    // airports & runways
    const lat = world.proj.lat(ac.pos.z), lon = world.proj.lon(ac.pos.x);
    const apts = world.db.near(lat, lon, this.ndRange * NM * 1.2, 0).slice(0, 40);
    for (const a of apts) {
      const [sx, sy] = toScreen(a.x, a.z);
      for (const r of a.runways) {
        const [x1, y1] = toScreen(r.ends[0].x, r.ends[0].z), [x2, y2] = toScreen(r.ends[1].x, r.ends[1].z);
        g.strokeStyle = '#fff'; g.lineWidth = Math.max(2, r.width / mpp); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      }
      g.fillStyle = a.type >= 1 ? '#46d6ff' : '#9bb'; g.font = `${Math.round(H * 0.05)}px monospace`; g.textAlign = 'left';
      g.fillText(a.ident, sx + 6, sy - 4);
    }
    // ILS course line
    if (this.ils) {
      const r = this.ils.rw, e = r.ends[this.ils.end], o = r.ends[1 - this.ils.end];
      const ux = (e.x - o.x) / r.length, uz = (e.z - o.z) / r.length;
      const [a1, b1] = toScreen(e.x, e.z), [a2, b2] = toScreen(e.x + ux * 18 * NM, e.z + uz * 18 * NM);
      g.strokeStyle = '#ff4fd8'; g.lineWidth = 1.5; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(a1, b1); g.lineTo(a2, b2); g.stroke(); g.setLineDash([]);
    }
    // cargo / scenario target
    if (this.target) {
      const tx = world.proj.x(this.target.lon), tz = world.proj.z(this.target.lat);
      const [sx, sy] = toScreen(tx, tz);
      g.strokeStyle = '#ff4fd8'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx, cy); g.lineTo(sx, sy); g.stroke();
      g.fillStyle = '#ff4fd8'; g.fillText(this.target.name, Math.min(W - 60, Math.max(2, sx + 6)), Math.max(12, sy));
    }
    // track line
    g.strokeStyle = '#3cf27a'; g.lineWidth = 1; g.beginPath(); g.moveTo(cx, cy);
    const tr = wrap180(ac.trk - ac.hdg) * DEG; g.lineTo(cx + Math.sin(tr) * R, cy - Math.cos(tr) * R); g.stroke();
    g.restore();
    // compass rose
    g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 1; g.font = `${Math.round(H * 0.05)}px monospace`; g.textAlign = 'center';
    for (let d = 0; d < 360; d += 10) {
      const a = (d - ac.hdg) * DEG; if (Math.cos(a) < -0.1) continue;
      const x0 = cx + Math.sin(a) * R, y0 = cy - Math.cos(a) * R, x1 = cx + Math.sin(a) * R * (d % 30 ? 0.96 : 0.93), y1 = cy - Math.cos(a) * R * (d % 30 ? 0.96 : 0.93);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
      if (d % 30 === 0) g.fillText(String(d / 10), cx + Math.sin(a) * R * 0.86, cy - Math.cos(a) * R * 0.86 + 4);
    }
    // aircraft symbol
    g.strokeStyle = '#ffd400'; g.lineWidth = 2.5; g.beginPath(); g.moveTo(cx, cy - 10); g.lineTo(cx, cy + 10); g.moveTo(cx - 9, cy - 2); g.lineTo(cx + 9, cy - 2); g.moveTo(cx - 4, cy + 8); g.lineTo(cx + 4, cy + 8); g.stroke();
    // header: heading, wind, GS/TAS
    const wind = ac.weather.s;
    g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = `${Math.round(H * 0.055)}px monospace`;
    g.fillText(`GS${Math.round(ac.gs)} TAS${Math.round(ac.tas / KT)}`, 4, H - 22);
    g.fillText(`${Math.round(wind.windDir).toString().padStart(3, '0')}/${Math.round(wind.windKt)}`, 4, H - 8);
    const wa = (wind.windDir + 180 - ac.hdg) * DEG;
    g.save(); g.translate(60, H - 14); g.rotate(wa); g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(0, -7); g.lineTo(0, 7); g.lineTo(-3, 3); g.moveTo(0, 7); g.lineTo(3, 3); g.stroke(); g.restore();
    g.textAlign = 'right'; g.fillText(`${this.ndRange}NM`, W - 4, H - 8);
    g.textAlign = 'center'; g.fillStyle = '#ffd400'; g.font = `bold ${Math.round(H * 0.06)}px monospace`;
    g.fillText(Math.round(ac.hdg).toString().padStart(3, '0'), cx, 12);
    if (this.target) {
      const tx = world.proj.x(this.target.lon), tz = world.proj.z(this.target.lat);
      const d = Math.hypot(tx - ac.pos.x, tz - ac.pos.z) / NM;
      g.fillStyle = '#ff4fd8'; g.textAlign = 'right'; g.font = `${Math.round(H * 0.05)}px monospace`;
      g.fillText(`${this.target.name} ${d.toFixed(0)}NM`, W - 4, 12);
    }
  }

  private drawEng(ac: Aircraft) {
    const g = this.ctx(this.eng), W = this.eng.width / this.dpr, H = this.eng.height / this.dpr;
    g.clearRect(0, 0, W, H);
    const n = ac.engines.length, bw = Math.min(16, (W - 10) / n - 4);
    g.font = `${Math.round(H * 0.09)}px monospace`; g.textAlign = 'center';
    ac.engines.forEach((e, i) => {
      const x = 6 + i * (bw + 4) + bw / 2, top = 10, h = H * 0.55;
      g.fillStyle = '#222'; g.fillRect(x - bw / 2, top, bw, h);
      const bad = e.failed || e.out || e.extinguished;
      g.fillStyle = e.fire ? '#ff3030' : bad ? '#ffb000' : '#3cf27a';
      g.fillRect(x - bw / 2, top + h * (1 - Math.min(1, e.n1)), bw, h * Math.min(1, e.n1));
      g.fillStyle = e.fire ? '#ff3030' : bad ? '#ffb000' : '#fff';
      g.fillText(e.fire ? 'FIRE' : bad ? 'FAIL' : String(Math.round(e.n1 * 100)), x, top + h + 12);
    });
    g.fillStyle = ac.fuel < ac.t.fuelMax * 0.08 ? '#ffb000' : '#fff'; g.textAlign = 'left';
    g.fillText(`FOB ${(ac.fuel / 1000).toFixed(1)}t`, 4, H - 16);
    g.fillText(`GW ${(ac.mass / 1000).toFixed(1)}t`, 4, H - 4);
    const flap = ac.t.flaps[Math.round(ac.flapPos)]?.name ?? '';
    g.textAlign = 'right';
    g.fillText(`F ${flap}`, W - 3, H - 16);
    g.fillStyle = ac.gearPos > 0.99 ? '#3cf27a' : ac.gearPos > 0.01 ? '#ff4040' : '#888';
    g.fillText(ac.gearPos > 0.99 ? 'GEAR▼' : ac.gearPos > 0.01 ? 'GEAR…' : 'GEAR▲', W - 3, H - 4);
  }
}
