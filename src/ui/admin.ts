// Serbest Uçuş admin panel: tiny semi-transparent button (top-right) → compact scrollable panel.
import type { Game } from '../game/game';
import { FT, KT, atmosphere } from '../core/geo';

export class AdminPanel {
  btn = document.createElement('button');
  panel = document.createElement('div');
  open = false;
  constructor(private host: HTMLElement, private game: Game, private teleport: (apt: string, onRunway: boolean) => void) {
    this.btn.className = 'admin-btn ia'; this.btn.textContent = '⚙';
    this.btn.onclick = () => this.toggle();
    this.panel.className = 'admin ia'; this.panel.style.display = 'none';
    host.append(this.btn, this.panel);
    this.hide();
  }
  show() { this.btn.style.display = ''; }
  hide() { this.btn.style.display = 'none'; this.panel.style.display = 'none'; this.open = false; }
  toggle() { this.open = !this.open; this.panel.style.display = this.open ? '' : 'none'; if (this.open) this.render(); }

  private render() {
    const g = this.game, ac = g.ac; if (!ac) return;
    const w = g.weather.s;
    const eng = ac.engines.map((e, i) => `
      <button data-k="fail" data-i="${i}" class="${e.failed ? 'on' : ''}">M${i + 1} ${e.failed ? 'ARIZALI' : 'arıza'}</button>
      <button data-k="fire" data-i="${i}" class="${e.fire ? 'on' : ''}">M${i + 1} ${e.fire ? 'söndür' : 'yangın'}</button>`).join('');
    const airports = [...g.world.regionAirports, ...[...g.world.active.values()].filter(a => !g.world.regionAirports.includes(a))].slice(0, 16);
    const rng = (k: string, label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string) =>
      `<div class="arange"><span>${label}</span><input type="range" data-r="${k}" min="${min}" max="${max}" step="${step}" value="${val}"><span data-o="${k}">${fmt(val)}</span></div>`;
    this.panel.innerHTML = `
      <h4>Motorlar</h4><div class="abtns">${eng}
        <button data-k="failall">Hepsini arızala</button><button data-k="repairall">Hepsini onar</button></div>
      <h4>Kanatlar</h4><div class="abtns">
        <button data-k="wingL" class="${ac.sys.wingLost[0] ? 'on' : ''}">Sol kanat kopar</button><button data-k="wingR" class="${ac.sys.wingLost[1] ? 'on' : ''}">Sağ kanat kopar</button><button data-k="wingfix">Kanatları onar</button></div>
      <h4>Sistemler</h4><div class="abtns">
        <button data-k="gear" class="${ac.sys.gearJam ? 'on' : ''}">İniş takımı arızası</button>
        <button data-k="hyd" class="${!ac.sys.hydraulics ? 'on' : ''}">Hidrolik</button>
        <button data-k="elec" class="${!ac.sys.electrics ? 'on' : ''}">Elektrik</button>
        <button data-k="pitot" class="${!ac.sys.pitot ? 'on' : ''}">Pitot (hız)</button>
        <button data-k="flapjam" class="${ac.sys.flapsJam ? 'on' : ''}">Flap sıkışması</button></div>
      <h4>Hasar</h4><div class="abtns">
        <button data-k="fixall">Her şeyi onar</button>
        <button data-k="inv" class="${ac.sys.invincible ? 'on' : ''}">Ölümsüzlük</button>
        <button data-k="tail" class="${ac.sys.tailDamage > 0 ? 'on' : ''}">Kuyruk hasarı</button></div>
      <h4>Yakıt & ağırlık</h4>
      ${rng('fuel', 'Yakıt %', 0, 100, 1, Math.round(ac.fuel / ac.t.fuelMax * 100), v => v + '%')}
      ${rng('payload', 'Yük %', 0, 100, 1, Math.round(ac.payload / ac.t.payloadMax * 100), v => v + '%')}
      <div class="abtns"><button data-k="refuel">Yakıt doldur</button><button data-k="leak" class="${ac.sys.fuelLeak > 0 ? 'on' : ''}">Yakıt sızıntısı</button></div>
      <h4>Uçuş</h4>
      ${rng('alt', 'İrtifa ft', 500, 41000, 500, Math.round(ac.alt / FT / 500) * 500, v => String(v))}
      ${rng('spd', 'Hız kt', 100, 360, 5, Math.round(ac.ias / 5) * 5, v => String(v))}
      <div class="abtns"><button data-k="setalt">İrtifayı uygula</button><button data-k="setspd">Hızı uygula</button>
        <button data-k="pause">${g.paused ? 'Devam' : 'Duraklat'}</button>
        <button data-k="slow25" class="${g.timeScale === 0.25 ? 'on' : ''}">0.25×</button><button data-k="slow5" class="${g.timeScale === 0.5 ? 'on' : ''}">0.5×</button><button data-k="slow1">1×</button></div>
      <div class="abtns" style="margin-top:6px"><select data-k="tpapt">${airports.map(a => `<option value="${a.ident}">${a.ident} ${a.name.slice(0, 22)}</option>`).join('')}</select></div>
      <div class="abtns"><button data-k="tprwy">Piste ışınla</button><button data-k="tpfinal">10 km finale ışınla</button></div>
      <h4>Çevre</h4>
      ${rng('wdir', 'Rüzgâr yönü', 0, 355, 5, w.windDir, v => v + '°')}
      ${rng('wkt', 'Rüzgâr kt', 0, 60, 1, w.windKt, v => v + ' kt')}
      ${rng('gust', 'Hamle kt', 0, 30, 1, w.gustKt, v => v + ' kt')}
      ${rng('turb', 'Türbülans', 0, 100, 5, Math.round(w.turb * 100), v => v + '%')}
      ${rng('rain', 'Yağmur', 0, 100, 5, Math.round(w.rain * 100), v => v + '%')}
      ${rng('vis', 'Görüş m', 200, 60000, 100, w.visibility, v => v >= 10000 ? (v / 1000).toFixed(0) + ' km' : v + ' m')}
      ${rng('hour', 'Saat', 0, 23.5, 0.5, w.hour, v => `${Math.floor(v).toString().padStart(2, '0')}:${v % 1 ? '30' : '00'}`)}
      <div class="abtns"><button data-k="cross">Piste dik yan rüzgâr</button></div>`;
    this.panel.querySelectorAll<HTMLButtonElement>('button[data-k]').forEach(b => b.onclick = () => { this.act(b.dataset.k!, +(b.dataset.i ?? 0)); this.render(); });
    this.panel.querySelectorAll<HTMLInputElement>('input[data-r]').forEach(inp => inp.oninput = () => this.range(inp.dataset.r!, +inp.value, inp));
  }

  private act(k: string, i: number) {
    const g = this.game, ac = g.ac!; const sys = ac.sys;
    const sel = this.panel.querySelector<HTMLSelectElement>('select[data-k="tpapt"]');
    switch (k) {
      case 'fail': { const e = ac.engines[i]; e.failed = !e.failed; if (!e.failed) { e.out = false; e.extinguished = false; e.damaged = 0; } break; }
      case 'fire': { const e = ac.engines[i]; if (e.fire) { e.fire = false; } else { e.fire = true; e.fireT = 0; e.extinguished = false; } break; }
      case 'failall': ac.engines.forEach(e => e.failed = true); g.hud.glideRing = true; break;
      case 'repairall': ac.engines.forEach(e => { e.failed = false; e.fire = false; e.out = false; e.extinguished = false; e.damaged = 0; }); break;
      case 'wingL': ac.breakWing(-1, 'admin'); break;
      case 'wingR': ac.breakWing(1, 'admin'); break;
      case 'wingfix': ac.repairWings(); break;
      case 'gear': sys.gearJam = !sys.gearJam; break;
      case 'hyd': sys.hydraulics = !sys.hydraulics; break;
      case 'elec': sys.electrics = !sys.electrics; break;
      case 'pitot': sys.pitot = !sys.pitot; ac.iasDisplayed = ac.ias; break;
      case 'flapjam': sys.flapsJam = !sys.flapsJam; break;
      case 'fixall':
        ac.engines.forEach(e => { e.failed = false; e.fire = false; e.out = false; e.extinguished = false; e.damaged = 0; });
        Object.assign(sys, { hydraulics: true, electrics: true, pitot: true, flapsJam: false, gearJam: false, tailDamage: 0, fuelLeak: 0, gearCollapsed: [false, false, false] });
        ac.repairWings(); break;
      case 'inv': sys.invincible = !sys.invincible; break;
      case 'tail': sys.tailDamage = sys.tailDamage > 0 ? 0 : 0.7; break;
      case 'refuel': ac.fuel = ac.t.fuelMax; break;
      case 'leak': sys.fuelLeak = sys.fuelLeak > 0 ? 0 : 6; break;
      case 'setalt': { const v = +this.val('alt'); const gnd = g.world.ground(ac.pos.x, ac.pos.z).h; ac.pos.y = Math.max(gnd + 150, v * FT); ac.vel.y = 0; ac.onGround = false; ac.touchdown.firstContact = 0; break; }
      case 'setspd': { const v = +this.val('spd'); const tas = v * KT / Math.sqrt(atmosphere(ac.pos.y).sigma); ac.vel.copy(ac.forward().multiplyScalar(tas)); break; }
      case 'pause': g.paused = !g.paused; break;
      case 'slow25': g.timeScale = 0.25; break;
      case 'slow5': g.timeScale = 0.5; break;
      case 'slow1': g.timeScale = 1; break;
      case 'tprwy': if (sel) this.teleport(sel.value, true); break;
      case 'tpfinal': if (sel) this.teleport(sel.value, false); break;
      case 'cross': {
        let best = 0, bd = 1e12;
        for (const a of g.world.active.values()) for (const r of a.runways) { const d = (r.cx - ac.pos.x) ** 2 + (r.cz - ac.pos.z) ** 2; if (d < bd) { bd = d; best = r.hdg; } }
        g.weather.set({ windDir: (best + 90) % 360, windKt: Math.max(20, g.weather.s.windKt) });
        break;
      }
    }
  }
  private val(k: string) { return this.panel.querySelector<HTMLInputElement>(`input[data-r="${k}"]`)!.value; }
  private range(k: string, v: number, inp: HTMLInputElement) {
    const g = this.game, ac = g.ac!; const w = g.weather;
    const out = this.panel.querySelector(`[data-o="${k}"]`);
    switch (k) {
      case 'fuel': ac.fuel = ac.t.fuelMax * v / 100; break;
      case 'payload': ac.payload = ac.t.payloadMax * v / 100; break;
      case 'wdir': w.set({ windDir: v }); break;
      case 'wkt': w.set({ windKt: v }); break;
      case 'gust': w.set({ gustKt: v }); break;
      case 'turb': w.set({ turb: v / 100 }); break;
      case 'rain': w.set({ rain: v / 100, cloud: Math.max(w.s.cloud, v / 100) }); g.world.sky.cloud = w.s.cloud; break;
      case 'vis': w.set({ visibility: v }); g.world.sky.visibility = v; break;
      case 'hour': w.set({ hour: v }); g.world.sky.hour = v; break;
    }
    if (out) out.textContent = k === 'vis' ? (v >= 10000 ? (v / 1000).toFixed(0) + ' km' : v + ' m') : k === 'hour' ? `${Math.floor(v).toString().padStart(2, '0')}:${v % 1 ? '30' : '00'}` : k === 'wdir' ? v + '°' : String(v);
    void inp;
  }
}
