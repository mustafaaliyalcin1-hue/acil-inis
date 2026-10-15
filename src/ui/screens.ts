// Turkish menu screens (DOM): main menu, free flight setup, emergency, cargo career, offline pack, settings,
// pause, results.
import { store } from '../core/store';
import { AIRCRAFT, FREIGHTERS, typeById, AircraftType } from '../sim/aircraftData';
import { SCENARIOS, randomScenario, Scenario } from '../game/scenarios';
import { pack, PackProgress } from '../world/pack';
import { career, genContracts, money, activePlane, buyPlane, repair, repairCost, tripFuel, FUEL_PRICE, persist, Contract, settle, newCareer } from '../game/cargo';
import type { Game, Session, FlightResult } from '../game/game';
import type { Airport } from '../world/airports';
import { Controls } from './controls';
import { haversine, KT } from '../core/geo';
import type { WeatherState } from '../world/weather';
import regionCfg from '../data/region.json';

const h = (s: string) => { const d = document.createElement('div'); d.innerHTML = s.trim(); return d.firstElementChild as HTMLElement; };
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class Screens {
  ui: HTMLElement;
  cur: HTMLElement | null = null;
  constructor(public game: Game, public startFlight: (s: Omit<Session, 'onEnd' | 'onExit'>) => void) {
    this.ui = document.getElementById('ui')!;
  }
  show(el: HTMLElement) { this.cur?.remove(); this.cur = el; this.ui.appendChild(el); }
  close() { this.cur?.remove(); this.cur = null; }
  toast(t: string, ms = 2600) {
    const d = h(`<div class="toast">${esc(t)}</div>`); document.getElementById('app')!.appendChild(d);
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 500); }, ms);
  }
  private head(title: string, back: () => void, right = '') {
    const e = h(`<div class="scr-head"><button class="back">‹</button><div class="scr-title">${title}</div>${right}</div>`);
    e.querySelector('.back')!.addEventListener('click', back);
    return e;
  }
  private region(): Airport[] { return this.game.world.regionAirports; }

  // ---------------------------------------------------------------- main menu
  main() {
    const online = store.settings.worldMode === 'online';
    const st = pack.ready ? `<span class="tag ok">Offline paket hazır ✓</span>` : `<span class="tag red">Offline paket yok</span>`;
    const c = store.data.career;
    const e = h(`<div class="screen clear"><div class="menu-main">
      <div class="menu-logo"><h1>ACİL İNİŞ</h1><div class="sub">Gerçekçi yolcu uçağı uçuş ve acil iniş simülatörü</div>
        <div class="status">${st} <span class="tag">${online ? 'Online dünya' : 'Offline · Marmara'}</span>${c ? ` <span class="tag yel">Kariyer: ${money(c.money)}</span>` : ''}</div>
        <div class="status" style="color:var(--muted);font-size:12px;margin-top:10px">${store.data.flights} uçuş · Zorluk: ${store.settings.difficulty === 'easy' ? 'Kolay' : 'Gerçekçi'}</div></div>
      <div class="menu-btns">
        <button class="mbtn" data-a="free"><span class="ico">🛫</span><div><b>Serbest Uçuş</b><span>İstediğin havalimanı, uçak ve hava · admin paneli</span></div></button>
        <button class="mbtn hi" data-a="emg"><span class="ico">🚨</span><div><b>Acil Durum</b><span>Motor arızası, süzülme, suya iniş · 23 senaryo</span></div></button>
        <button class="mbtn" data-a="cargo"><span class="ico">📦</span><div><b>Yük Modu</b><span>Kariyer: sözleşmeler, para, hangar</span></div></button>
        <div class="mini-row">
          <button class="mbtn" data-a="tut"><span class="ico">🎓</span><div><b>Eğitim</b></div></button>
          <button class="mbtn" data-a="pack"><span class="ico">⬇️</span><div><b>Offline Paket</b></div></button>
          <button class="mbtn" data-a="set"><span class="ico">⚙️</span><div><b>Ayarlar</b></div></button>
        </div>
      </div></div></div>`);
    e.querySelectorAll<HTMLButtonElement>('[data-a]').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      if (!pack.ready && store.settings.worldMode === 'offline' && a !== 'pack' && a !== 'set') { this.toast('Önce Offline Paket\'i indirin (Wi-Fi) ya da Ayarlar\'dan Online moda geçin.'); this.packScreen(); return; }
      if (a === 'free') this.free(); if (a === 'emg') this.emergency(); if (a === 'cargo') this.cargo();
      if (a === 'pack') this.packScreen(); if (a === 'set') this.settings(); if (a === 'tut') this.tutorial();
    });
    this.show(e);
  }

  // ---------------------------------------------------------------- shared pickers
  private aircraftGrid(list: AircraftType[], sel: string, onSel: (id: string) => void) {
    const g = h(`<div class="grid"></div>`);
    for (const t of list) {
      const c = h(`<button class="card ${t.id === sel ? 'sel' : ''}"><h3>${esc(t.name)}</h3>
        <p>${t.engines}× ${t.kind === 'jet' ? 'jet' : t.kind === 'turboprop' ? 'turboprop' : 'pistonlu'} · MTOW ${(t.mtow / 1000).toFixed(t.mtow < 10000 ? 1 : 0)} t · ${t.seats ? t.seats + ' koltuk' : 'kargo'}</p>
        <p>Vref ~${Math.round(1.23 * Math.sqrt(2 * t.mlw * 9.81 * 0.95 / (1.225 * t.S * (t.CLmax + t.flaps[t.flaps.length - 1].dCLmax))) / KT)} kt · ${t.fbw ? 'Fly-by-wire' : 'Konvansiyonel'}</p></button>`);
      c.onclick = () => { g.querySelectorAll('.card').forEach(x => x.classList.remove('sel')); c.classList.add('sel'); onSel(t.id); };
      g.appendChild(c);
    }
    return g;
  }
  private seg<T extends string>(opts: [T, string][], cur: T, on: (v: T) => void) {
    const s = h(`<div class="seg"></div>`);
    for (const [v, l] of opts) { const b = h(`<button class="${v === cur ? 'on' : ''}">${l}</button>`); b.onclick = () => { s.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); on(v); }; s.appendChild(b); }
    return s;
  }
  private weatherFrom(preset: string, time: string): Partial<WeatherState> {
    const hour = time === 'morning' ? 8 : time === 'noon' ? 13 : time === 'sunset' ? 18.2 : 23;
    const w: Partial<WeatherState> = { hour };
    if (preset === 'clear') Object.assign(w, { cloud: 0.1, visibility: 60000, windKt: 6, turb: 0.05 });
    if (preset === 'cloudy') Object.assign(w, { cloud: 0.6, visibility: 25000, windKt: 12, turb: 0.15 });
    if (preset === 'rain') Object.assign(w, { cloud: 0.9, visibility: 5000, windKt: 15, gustKt: 6, rain: 0.8, turb: 0.25 });
    if (preset === 'fog') Object.assign(w, { cloud: 0.95, visibility: 700, windKt: 3, turb: 0.02 });
    if (preset === 'storm') Object.assign(w, { cloud: 1, visibility: 3000, windKt: 32, gustKt: 15, rain: 1, turb: 0.6 });
    return w;
  }

  // ---------------------------------------------------------------- free flight
  free() {
    const regionAps = this.region();
    let apt = regionAps[0]?.ident ?? 'LTFM', end = 0, startKind: 'runway' | 'final' | 'air' = 'runway', type = 'a320', wx = 'clear', tm = 'noon';
    const e = h(`<div class="screen"></div>`);
    e.appendChild(this.head('Serbest Uçuş', () => this.main()));
    const body = h(`<div class="scr-body"></div>`);
    const online = store.settings.worldMode === 'online';
    body.appendChild(h(`<div class="sec">Havalimanı</div>`));
    const search = h(`<input type="search" placeholder="${online ? 'ICAO kodu veya isim ara (dünya geneli)…' : 'Ara…'}">`) as HTMLInputElement;
    const apList = h(`<div class="grid wide"></div>`);
    const rwList = h(`<div class="row"></div>`);
    const renderRw = () => {
      rwList.innerHTML = '';
      const a = this.game.world.db.byId.get(apt); if (!a) return;
      a.runways.forEach((r, ri) => r.ends.forEach((en, ei) => {
        const idx = ri * 2 + ei;
        const b = h(`<button class="btn small ${idx === end ? 'primary' : ''}">${en.ident} · ${Math.round(r.length)} m${en.ils ? ' · ILS' : ''}</button>`);
        b.onclick = () => { end = idx; renderRw(); }; rwList.appendChild(b);
      }));
    };
    const renderAps = (q = '') => {
      apList.innerHTML = '';
      let list = regionAps;
      if (q.length >= 2) { const Q = q.toLocaleUpperCase('tr'); list = this.game.world.db.list.filter(a => (online || regionAps.includes(a) || this.inRegion(a)) && (a.ident.includes(Q) || a.name.toLocaleUpperCase('tr').includes(Q) || a.city.toLocaleUpperCase('tr').includes(Q))).slice(0, 30); }
      for (const a of list) {
        const c = h(`<button class="card ${a.ident === apt ? 'sel' : ''}"><h3>${a.ident} · ${esc(a.name)}</h3><p>${esc(a.city)} · ${a.runways.length} pist · ${Math.round(Math.max(...a.runways.map(r => r.length)))} m</p></button>`);
        c.onclick = () => { apt = a.ident; end = 0; renderAps(search.value); renderRw(); };
        apList.appendChild(c);
      }
    };
    search.oninput = () => renderAps(search.value);
    body.append(search, apList, h(`<div class="sec">Pist</div>`), rwList, h(`<div class="sec">Başlangıç</div>`));
    body.appendChild(this.seg([['runway', 'Pistte'], ['final', '10 km final'], ['air', 'Havada (5000 ft)']], startKind, v => startKind = v));
    body.appendChild(h(`<div class="sec">Hava ve saat</div>`));
    const wrow = h(`<div class="cols"></div>`);
    wrow.append(this.seg([['clear', 'Açık'], ['cloudy', 'Bulutlu'], ['rain', 'Yağmur'], ['fog', 'Sis'], ['storm', 'Fırtına']], wx as any, v => wx = v),
      this.seg([['morning', 'Sabah'], ['noon', 'Öğle'], ['sunset', 'Gün batımı'], ['night', 'Gece']], tm as any, v => tm = v));
    body.appendChild(wrow);
    body.appendChild(h(`<div class="sec">Uçak (hepsi açık)</div>`));
    body.appendChild(this.aircraftGrid(AIRCRAFT, type, id => type = id));
    e.appendChild(body);
    const foot = h(`<div class="scr-foot"><button class="btn primary">Uçuşa başla ▶</button></div>`);
    foot.querySelector('button')!.addEventListener('click', () => {
      const t = typeById(type);
      const start = startKind === 'runway' ? { kind: 'runway' as const, apt, end } : startKind === 'final' ? { kind: 'final' as const, apt, end, distKm: 10, aglFt: 1750, kt: Math.round(t.vr * 1.12) } : { kind: 'air' as const, apt, bearing: 200, distKm: 25, altFt: 5000, kt: Math.min(250, t.vmo - 20) };
      this.startFlight({ mode: 'free', type: t, weather: this.weatherFrom(wx, tm), start, pax: Math.round(t.seats * 0.85), engineFail: 'none' });
    });
    e.appendChild(foot);
    renderAps(); renderRw();
    this.show(e);
  }
  private inRegion(a: Airport) { const b = regionCfg.bbox; return a.lat > b.south && a.lat < b.north && a.lon > b.west && a.lon < b.east; }

  // ---------------------------------------------------------------- emergency
  emergency() {
    let sel: Scenario = SCENARIOS[0], fail: 'scenario' | 'random' | 'one' | 'all' = 'scenario', acSel: string | null = null;
    const e = h(`<div class="screen"></div>`);
    e.appendChild(this.head('Acil Durum', () => this.main()));
    const body = h(`<div class="scr-body"></div>`);
    body.appendChild(h(`<div class="sec">Senaryo</div>`));
    const grid = h(`<div class="grid wide"></div>`);
    const renderCards = () => {
      grid.innerHTML = '';
      const rnd = h(`<button class="card ${sel.id.startsWith('rnd') ? 'sel' : ''}"><h3>🎲 Rastgele senaryo</h3><p>Rastgele havalimanı, irtifa, uçak ve 1-2 komplikasyon.</p></button>`);
      rnd.onclick = () => { sel = randomScenario(); renderCards(); };
      grid.appendChild(rnd);
      for (const s of SCENARIOS) {
        const best = store.data.scores[s.id];
        const c = h(`<button class="card ${s.id === sel.id ? 'sel' : ''}"><h3>${esc(s.name)} ${best ? '<span style="color:var(--warn)">' + '★'.repeat(best.stars) + '</span>' : ''}</h3>
          <p>${esc(s.desc)}</p><div>${s.engines === 'all' ? '<span class="tag red">Tüm motorlar</span>' : s.engines === 'asym2' ? '<span class="tag red">2 motor</span>' : '<span class="tag yel">Tek motor</span>'}
          <span class="tag">${typeById(s.aircraft).short}</span>${s.tags.map(t => `<span class="tag">${t}</span>`).join('')}${s.inspired ? '<span class="tag ok">gerçek olaydan</span>' : ''}</div></button>`);
        c.onclick = () => { sel = s; renderCards(); };
        grid.appendChild(c);
      }
      if (sel.id.startsWith('rnd')) grid.firstElementChild!.querySelector('p')!.textContent = sel.desc;
    };
    renderCards();
    body.appendChild(grid);
    body.appendChild(h(`<div class="sec">Motor arızası</div>`));
    body.appendChild(this.seg([['scenario', 'Senaryodaki'], ['random', 'Rastgele'], ['one', 'Tek motor'], ['all', 'Tüm motorlar (süzülme)']], fail, v => fail = v));
    body.appendChild(h(`<div class="sec">Uçak (boş bırakılırsa senaryo uçağı)</div>`));
    body.appendChild(this.aircraftGrid(AIRCRAFT, '', id => acSel = id));
    e.appendChild(body);
    const foot = h(`<div class="scr-foot"><button class="btn primary">Başla ▶</button></div>`);
    foot.querySelector('button')!.addEventListener('click', () => {
      const s = sel;
      const t = typeById(acSel ?? s.aircraft);
      const ef = fail === 'scenario' ? s.engines : fail === 'random' ? (Math.random() < 0.5 ? 'one' : 'all') : fail;
      this.startFlight({ mode: 'emergency', type: t, weather: s.weather ?? {}, scenario: s, engineFail: ef, start: this.scenarioStart(s, t), pax: Math.round(t.seats * 0.9) || 6, fuelKg: s.fuelKg });
    });
    e.appendChild(foot);
    this.show(e);
  }
  scenarioStart(s: Scenario, t: AircraftType): Session['start'] {
    const st = s.start;
    const apt = this.game.world.db.byId.get(st.apt);
    if (st.end && apt) {
      let idx = 0;
      apt.runways.forEach((r, ri) => r.ends.forEach((e, ei) => { if (e.ident === st.end) idx = ri * 2 + ei; }));
      return { kind: 'final', apt: st.apt, end: idx, distKm: st.dist, aglFt: st.altFt, kt: Math.min(st.kt, t.vmo - 10) };
    }
    return { kind: 'air', apt: st.apt, bearing: st.bearing ?? 0, distKm: st.dist, altFt: st.altFt, hdg: st.hdg, kt: Math.min(st.kt, t.vmo - 10), climb: st.climb };
  }

  // ---------------------------------------------------------------- cargo career
  cargo(tab: 'board' | 'hangar' = 'board') {
    const c = career();
    const here = this.game.world.db.byId.get(c.location) ?? this.region()[0];
    const p = activePlane();
    const t = typeById(p.type);
    const e = h(`<div class="screen"></div>`);
    e.appendChild(this.head('Yük Modu', () => this.main(), `<div class="money big-num" style="font-size:20px">${money(c.money)}</div>`));
    const body = h(`<div class="scr-body"></div>`);
    body.appendChild(h(`<div class="row" style="margin-bottom:8px"><span class="tag">📍 ${here.ident} ${esc(here.name)}</span><span class="tag">✈ ${esc(t.name)} · %${Math.round(p.condition * 100)} sağlam</span><span class="tag">${c.deliveries} teslimat</span></div>`));
    const tabs = this.seg([['board', '📋 Sözleşmeler'], ['hangar', '🛠 Hangar']], tab, v => this.cargo(v));
    body.appendChild(tabs);
    if (tab === 'board') {
      const all = [...this.region(), ...this.game.world.db.list.filter(a => this.inRegion(a) && !this.region().includes(a) && a.type >= 1)];
      const cs = genContracts(here, all, p.type);
      body.appendChild(h(`<div class="sec">${here.ident} ilan panosu</div>`));
      if (p.condition < 0.35) body.appendChild(h(`<p style="color:var(--bad)">Uçağın durumu kritik. Uçmadan önce hangarda tamir ettirin.</p>`));
      for (const ct of cs) {
        const fit = ct.kg <= t.payloadMax;
        const dest = this.game.world.db.byId.get(ct.to)!;
        const rwOk = Math.max(...dest.runways.map(r => r.length)) >= (t.mtow > 60000 ? 1900 : t.mtow > 20000 ? 1300 : 600);
        const fuel = tripFuel(p.type, ct.distKm);
        const it = h(`<button class="list-item ${!fit || !rwOk ? 'locked' : ''}"><div style="font-size:24px">${ct.icon}</div><div class="grow"><b>${esc(ct.cargo)} · ${(ct.kg / 1000).toFixed(1)} t → ${ct.to}</b>
          <small>${esc(dest.name)} · ${ct.distKm} km · ${ct.deadlineMin} dk ${ct.urgent ? '· ⚡ ACİL' : ''}${ct.fragile ? ' · kırılgan' : ''} · yakıt ~${fuel} kg (${money(fuel * FUEL_PRICE)})</small></div>
          <div class="money">${money(ct.pay)}</div></button>`);
        it.onclick = () => {
          if (!fit) return this.toast('Bu yük uçağınızın kapasitesini aşıyor');
          if (!rwOk) return this.toast('Varış pisti bu uçak için kısa');
          if (p.condition < 0.35) return this.toast('Önce uçağı tamir edin');
          this.startFlight({ mode: 'cargo', type: t, weather: this.cargoWeather(ct), contract: ct, payloadKg: ct.kg, fuelKg: Math.min(t.fuelMax, fuel), pax: 2,
            start: { kind: 'runway', apt: here.ident, end: this.bestRunwayEnd(here, dest) }, engineFail: ct.distKm > 120 && Math.random() < ct.distKm / 1500 ? 'one' : 'none' });
        };
        body.appendChild(it);
      }
    } else {
      body.appendChild(h(`<div class="sec">Filonuz</div>`));
      for (const op of c.planes) {
        const ot = typeById(op.type);
        const it = h(`<div class="list-item"><div style="font-size:22px">${op.id === c.active ? '✅' : '✈'}</div><div class="grow"><b>${esc(ot.name)}</b><small>Durum %${Math.round(op.condition * 100)} · Konum ${op.at} · ${(ot.payloadMax / 1000).toFixed(1)} t kapasite</small></div>
          <button class="btn small" data-a="use">Seç</button><button class="btn small" data-a="fix" ${op.condition >= 0.999 ? 'disabled' : ''}>Tamir ${money(repairCost(op))}</button></div>`);
        it.querySelector<HTMLButtonElement>('[data-a="use"]')!.onclick = () => { c.active = op.id; c.location = op.at; persist(); this.cargo('hangar'); };
        it.querySelector<HTMLButtonElement>('[data-a="fix"]')!.onclick = () => { const err = repair(op); if (err) this.toast(err); this.cargo('hangar'); };
        body.appendChild(it);
      }
      body.appendChild(h(`<div class="sec">Uçak satın al</div>`));
      const owned = new Set(c.planes.map(x => x.type));
      let prevOwned = true;
      for (const ft of FREIGHTERS) {
        const has = owned.has(ft.id);
        const unlocked = has || prevOwned;
        prevOwned = has;
        const it = h(`<div class="list-item ${unlocked ? '' : 'locked'}"><div style="font-size:22px">${has ? '✅' : unlocked ? '🛒' : '🔒'}</div><div class="grow"><b>${esc(ft.name)}</b><small>${(ft.payloadMax / 1000).toFixed(1)} t yük · ${ft.engines} motor · MTOW ${(ft.mtow / 1000).toFixed(0)} t</small></div>
          <div class="money">${ft.price ? money(ft.price) : 'Başlangıç'}</div>${!has && unlocked ? '<button class="btn small primary">Satın al</button>' : ''}</div>`);
        it.querySelector('button')?.addEventListener('click', () => { const err = buyPlane(ft.id); if (err) this.toast(err); else this.toast(ft.name + ' filoya katıldı!'); this.cargo('hangar'); });
        body.appendChild(it);
      }
      const reset = h(`<button class="btn danger small" style="margin-top:12px">Kariyeri sıfırla</button>`);
      reset.onclick = () => { if (confirm('Kariyer silinsin mi?')) { store.data.career = newCareer(); persist(); this.cargo('hangar'); } };
      body.appendChild(reset);
    }
    e.appendChild(body);
    this.show(e);
  }
  private cargoWeather(ct: Contract): Partial<WeatherState> {
    const r = (parseInt(ct.id.slice(-3), 10) || 7) % 10;
    const hour = 6 + (r * 1.9) % 16;
    return r < 6 ? { hour, cloud: 0.2, windKt: 8 } : r < 8 ? { hour, cloud: 0.7, windKt: 15, turb: 0.2, visibility: 15000 } : { hour, cloud: 0.9, rain: 0.6, windKt: 18, gustKt: 6, visibility: 6000 };
  }
  private bestRunwayEnd(a: Airport, dest: Airport) {
    // departure end roughly into the wind would need weather; pick longest runway, direction toward destination
    let best = 0, bl = 0;
    a.runways.forEach((r, i) => { if (r.length > bl) { bl = r.length; best = i; } });
    const r = a.runways[best];
    const brg = Math.atan2(dest.x - a.x, -(dest.z - a.z)) * 180 / Math.PI;
    const d0 = Math.abs(((r.ends[0].hdg - brg + 540) % 360) - 180);
    return best * 2 + (d0 < 90 ? 0 : 1);
  }

  // ---------------------------------------------------------------- tutorial
  tutorial() {
    const t = typeById('a320');
    const apt = this.game.world.db.byId.get('LTBA') ? 'LTBA' : this.region()[0].ident;
    this.startFlight({ mode: 'tutorial', type: t, weather: { hour: 11, windKt: 4, windDir: 50, cloud: 0.1 }, start: { kind: 'runway', apt, end: 0 }, pax: 0, engineFail: 'none' });
  }

  // ---------------------------------------------------------------- offline pack
  packScreen() {
    const e = h(`<div class="screen"></div>`);
    e.appendChild(this.head('Offline Paket İndir', () => this.main()));
    const body = h(`<div class="scr-body"></div>`);
    body.innerHTML = `
      <p style="color:var(--muted);margin-top:0">Marmara bölgesi (~360×320 km): 10 havalimanı, havalimanlarının çevresinde yüksek çözünürlüklü uydu görüntüsü, arazi yükseklik verisi ve su maskesi. Bir kez Wi-Fi'da indirin, uçakta uçak modunda oynayın.</p>
      <div class="cols"><div>
        <div class="kv" id="pkv"><div>Durum</div><div id="pst">…</div><div>Boyut</div><div id="psz">…</div><div>İndirilen</div><div id="pdn">…</div><div>Hız</div><div id="psp">–</div><div>Depolama</div><div id="pqt">…</div></div>
        <div class="progress" style="margin-top:12px"><div id="pbar"></div></div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="pgo">İndir</button><button class="btn" id="ppause">Duraklat</button><button class="btn" id="pver">Bütünlük kontrolü</button><button class="btn danger small" id="pdel">Sil</button></div>
        <p id="pmsg" style="font-size:13px;color:var(--muted)"></p>
      </div><div>
        <div class="sec" style="margin-top:0">Havalimanları</div>
        <div style="font-size:13px;line-height:1.6">${this.region().map(a => `<b>${a.ident}</b> ${esc(a.name)}`).join('<br>')}</div>
      </div></div>`;
    e.appendChild(body);
    this.show(e);
    const $ = (id: string) => body.querySelector('#' + id) as HTMLElement;
    const mb = (b: number) => (b / 1e6).toFixed(0) + ' MB';
    const render = async (p: PackProgress) => {
      const m = pack.manifest;
      $('pst').innerHTML = pack.ready ? '<span style="color:var(--ok)">Hazır ✓</span>' : p.phase === 'download' ? 'İndiriliyor…' : p.phase === 'paused' ? 'Duraklatıldı' : p.phase === 'error' ? '<span style="color:var(--bad)">Hata</span>' : p.phase === 'verify' ? 'Kontrol ediliyor…' : 'Yüklü değil';
      if (m) $('psz').textContent = mb(m.totalSize);
      if (p.total) { $('pdn').textContent = `${mb(p.done)} / ${mb(p.total)} (${p.chunk}/${p.chunks} parça)`; ($('pbar') as HTMLElement).style.width = (p.done / p.total * 100).toFixed(1) + '%'; }
      $('psp').textContent = p.speed ? (p.speed / 1e6).toFixed(1) + ' MB/s · kalan ~' + Math.ceil((p.total - p.done) / p.speed / 60) + ' dk' : '–';
      $('pmsg').textContent = p.message ?? '';
      ($('pgo') as HTMLButtonElement).textContent = pack.ready ? 'Güncelle / Yeniden indir' : p.phase === 'paused' || p.done > 0 ? 'Devam et' : 'İndir';
    };
    const l = (p: PackProgress) => { if (!e.isConnected) { pack.listeners.delete(l); return; } render(p); };
    pack.listeners.add(l);
    (async () => {
      try { const est = await navigator.storage?.estimate?.(); $('pqt').textContent = est ? `${mb(est.usage ?? 0)} kullanılıyor / ${mb(est.quota ?? 0)} kota` : '–'; } catch { $('pqt').textContent = '–'; }
      const stored = await pack.storedBytes();
      if (!pack.manifest) try { const m = await pack.remoteManifest(); $('psz').textContent = mb(m.totalSize) + ' (tahmini)'; } catch { $('psz').textContent = navigator.onLine ? '–' : 'Çevrimdışı'; }
      render({ ...pack.progress, done: pack.progress.done || stored, total: pack.progress.total || pack.manifest?.totalSize || 0 });
    })();
    $('pgo').onclick = () => { if (!navigator.onLine) return this.toast('İnternet bağlantısı yok'); pack.download(); };
    $('ppause').onclick = () => pack.pause();
    $('pver').onclick = async () => { const r = await pack.verify(); this.toast(r.ok ? 'Bütünlük doğrulandı ✓' : `${r.bad.length} bozuk parça`); };
    $('pdel').onclick = async () => { if (!confirm('Offline paket silinsin mi?')) return; await pack.clear(); this.toast('Paket silindi'); this.packScreen(); };
  }

  // ---------------------------------------------------------------- settings
  settings(back: () => void = () => this.main()) {
    const s = store.settings;
    const e = h(`<div class="screen"></div>`);
    e.appendChild(this.head('Ayarlar', back));
    const body = h(`<div class="scr-body"><div class="cols"><div id="c1"></div><div id="c2"></div></div></div>`);
    const c1 = body.querySelector('#c1')!, c2 = body.querySelector('#c2')!;
    const field = (label: string, el: HTMLElement, host: Element) => { const f = h(`<div class="field"><label>${label}</label></div>`); f.appendChild(el); host.appendChild(f); };
    field('Grafik kalitesi', this.seg([['auto', 'Otomatik'], ['low', 'Düşük'], ['med', 'Orta'], ['high', 'Yüksek']], s.quality, v => { store.set('quality', v); this.game.world.applyQuality(v); this.toast('Bazı ayarlar yeniden başlatınca tam etkili olur'); }), c1);
    field('Kontrol', this.seg([['joystick', 'Sanal joystick'], ['tilt', 'Telefonu eğ']], s.control, async v => {
      if (v === 'tilt') { const ok = await Controls.requestTilt(); if (!ok) { this.toast('Hareket sensörü izni verilmedi'); return; } }
      store.set('control', v);
    }), c1);
    const cal = h(`<button class="btn small">Eğimi kalibre et (telefonu nötr tutun)</button>`); cal.onclick = () => { this.game.controls.calibrate(); this.toast('Kalibre edildi'); };
    field('Eğim kalibrasyonu', cal, c1);
    const rng = (k: 'tiltSens' | 'stickSens' | 'volume' | 'hudScale', min: number, max: number, step: number) => {
      const i = h(`<input type="range" min="${min}" max="${max}" step="${step}" value="${s[k]}">`) as HTMLInputElement;
      i.oninput = () => { store.set(k, +i.value); if (k === 'hudScale') this.game.hud.layout(); }; return i;
    };
    field('Eğim hassasiyeti', rng('tiltSens', 0.4, 2, 0.05), c1);
    field('Joystick hassasiyeti', rng('stickSens', 0.4, 2, 0.05), c1);
    field('Yunuslama ters', this.seg([['0', 'Normal (çek = burun yukarı)'], ['1', 'Ters']], s.invertPitch ? '1' : '0', v => store.set('invertPitch', v === '1')), c1);
    field('Zorluk', this.seg([['real', 'Gerçekçi'], ['easy', 'Kolay (stabilite asisti)']], s.difficulty, v => store.set('difficulty', v)), c1);
    field('HUD boyutu', rng('hudScale', 0.7, 1.3, 0.05), c1);
    field('Ses seviyesi', rng('volume', 0, 1, 0.05), c2);
    field('Sesli anonslar (callout)', this.seg([['1', 'Açık'], ['0', 'Kapalı']], s.voice ? '1' : '0', v => store.set('voice', v === '1')), c2);
    field('Süzülme halkası (ND)', this.seg([['1', 'Açık'], ['0', 'Kapalı']], s.showGlideRing ? '1' : '0', v => store.set('showGlideRing', v === '1')), c2);
    field('Dünya', this.seg([['offline', 'Offline (Marmara paketi)'], ['online', 'Online (tüm dünya)']], s.worldMode, async v => {
      store.set('worldMode', v); this.toast(v === 'online' ? 'Online dünya: tile\'lar akıtılır, bağlantı koparsa önbellek kullanılır' : 'Offline mod'); await this.game.initWorld(v);
    }), c2);
    const key = h(`<input type="text" placeholder="Google Photorealistic 3D Tiles API anahtarı (isteğe bağlı)" value="${esc(s.googleKey)}">`) as HTMLInputElement;
    key.onchange = () => store.set('googleKey', key.value.trim());
    field('Google 3D Tiles (sadece online, önbelleğe alınmaz)', key, c2);
    const saveRow = h(`<div class="row"><button class="btn small" id="exp">Kaydı dışa aktar</button><button class="btn small" id="imp">Kaydı içe aktar</button><button class="btn small danger" id="rst">Sıfırla</button></div>`);
    saveRow.querySelector<HTMLButtonElement>('#exp')!.onclick = () => {
      const blob = new Blob([store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'acil-inis-kayit.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    };
    saveRow.querySelector<HTMLButtonElement>('#imp')!.onclick = () => {
      const i = document.createElement('input'); i.type = 'file'; i.accept = '.json,application/json';
      i.onchange = async () => { try { store.importJSON(await i.files![0].text()); this.toast('Kayıt yüklendi'); this.settings(back); } catch (err: any) { this.toast(err.message); } };
      i.click();
    };
    saveRow.querySelector<HTMLButtonElement>('#rst')!.onclick = () => { if (confirm('Tüm ayarlar, skorlar ve kariyer silinsin mi?')) { store.reset(); this.settings(back); } };
    field('Kayıt (ayarlar, skorlar, kariyer)', saveRow, c2);
    c2.appendChild(h(`<div class="sec">PC klavye kontrolleri</div>`));
    c2.appendChild(h(`<div style="font-size:12px;color:var(--muted);line-height:1.6">Ok tuşları / WASD: yunuslama ve yatış (↓ = burun yukarı) · Q/E: dümen · PageUp/PageDown veya +/−: gaz · Home: TOGA · End: rölanti<br>F / V: flap aç / topla · G: iniş takımı · Boşluk veya B: fren · K: park freni · R: ters itki · / : spoiler · . : spoiler ARM<br>T / Y: trim · C: kamera · H: HUD · Esc / P: duraklat · Fare sürükle: kamera döndür · Tekerlek: yakınlaş</div>`));
    c2.appendChild(h(`<div class="sec">Veri kaynakları ve atıflar</div>`));
    c2.appendChild(h(`<div style="font-size:12px;color:var(--muted);line-height:1.5">
      Uydu görüntüsü: Sentinel-2 cloudless 2024 — s2maps.eu, EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0<br>
      Yükseklik: Terrain Tiles — AWS Open Data / Mapzen (SRTM, GMTED2010, ETOPO1, NRCan, diğerleri)<br>
      Havalimanları ve pistler: OurAirports (public domain)<br>
      Sesler WebAudio ile üretilir. Uçak modelleri ve kaplamaları jeneriktir.</div>`));
    e.appendChild(body);
    this.show(e);
  }

  // ---------------------------------------------------------------- pause
  pause(onResume: () => void, onRestart: () => void, onExit: () => void) {
    const e = h(`<div class="screen clear" style="align-items:center;justify-content:center"><div class="card" style="min-width:300px;gap:10px;padding:18px">
      <h3 style="font-size:20px">Duraklatıldı</h3>
      <button class="btn primary" data-a="r">Devam et</button><button class="btn" data-a="re">Yeniden başlat</button>
      <button class="btn" data-a="c">Kontrol: ${store.settings.control === 'tilt' ? 'Eğim → Joystick' : 'Joystick → Eğim'}</button>
      <button class="btn" data-a="cal">Eğimi kalibre et</button>
      <button class="btn danger" data-a="x">Menüye dön</button></div></div>`);
    e.querySelectorAll<HTMLButtonElement>('[data-a]').forEach(b => b.onclick = async () => {
      const a = b.dataset.a;
      if (a === 'r') { this.close(); onResume(); }
      if (a === 're') { this.close(); onRestart(); }
      if (a === 'x') { this.close(); onExit(); }
      if (a === 'cal') { this.game.controls.calibrate(); this.toast('Kalibre edildi'); }
      if (a === 'c') {
        const v = store.settings.control === 'tilt' ? 'joystick' : 'tilt';
        if (v === 'tilt' && !(await Controls.requestTilt())) return this.toast('Hareket sensörü izni verilmedi');
        store.set('control', v); b.textContent = `Kontrol: ${v === 'tilt' ? 'Eğim → Joystick' : 'Joystick → Eğim'}`;
      }
    });
    this.show(e);
  }

  // ---------------------------------------------------------------- results
  results(r: FlightResult, onReplay: () => void, onRestart: () => void, onExit: () => void) {
    const s = r.session;
    let title = r.outcome === 'fatal' ? 'Kaza' : r.outcome === 'ditched' ? 'Suya iniş başarılı' : r.outcome === 'field' ? 'Zorunlu iniş' : 'İniş tamamlandı';
    let extra = '';
    if (s.mode === 'cargo' && s.contract) {
      const res = settle(s.contract, { minutes: r.minutes, vsFpm: r.vsFpm, crashed: r.outcome === 'fatal', atDest: r.atAirport?.ident === s.contract.to, fuelUsed: r.fuelUsed, condLoss: r.condLoss, dest: r.atAirport, mtow: s.type.mtow });
      title = res.delivered ? 'Teslimat tamamlandı' : r.outcome === 'fatal' ? 'Kaza — yük kaybedildi' : 'Teslimat başarısız';
      extra = `<div class="sec">Kazanç</div><div class="kv">
        <div>Ödeme</div><div class="money">${money(res.pay)}</div><div>Bonus</div><div class="money">${money(res.bonus)}</div>
        <div>Yakıt</div><div>-${money(res.fuelCost)}</div><div>İniş ücreti</div><div>-${money(res.fee)}</div>
        <div>Yük hasarı</div><div>%${res.damagePct}</div><div>Gecikme</div><div>${res.late ? 'Evet (-%40)' : 'Hayır'}</div>
        <div>Net</div><div class="money" style="font-size:18px">${money(res.net)}</div><div>Tamir gerekiyor</div><div>${res.repair ? money(res.repair) : '—'}</div></div>`;
    }
    if (s.mode === 'emergency' && s.scenario) store.score(s.scenario.id, { id: s.scenario.id, stars: r.stars, saved: r.saved, total: r.total, vs: r.vsFpm, site: r.site, at: Date.now(), aircraft: s.type.id });
    else store.score('_' + s.mode, { id: s.mode, stars: r.stars, saved: r.saved, total: r.total, vs: r.vsFpm, site: r.site, at: Date.now(), aircraft: s.type.id });
    const e = h(`<div class="screen"><div class="scr-head"><div class="scr-title">${title}</div></div><div class="scr-body"><div class="cols"><div>
      <div class="stars">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</div>
      ${r.total ? `<div class="big-num">${r.saved}/${r.total} yolcu kurtarıldı</div>` : ''}
      ${r.outcome === 'fatal' ? `<p style="color:var(--bad)">${esc(r.reason ?? '')}</p>` : ''}
      <div class="kv" style="margin-top:10px"><div>Temas dikey hızı</div><div>${Math.round(r.vsFpm)} fpm</div><div>İniş yeri</div><div>${r.site}${r.atAirport ? ' · ' + r.atAirport.ident : ''}</div>
      <div>Maks. yük faktörü</div><div>${r.peakG.toFixed(2)} g</div><div>Hasar</div><div>${r.damage.length ? r.damage.join(', ') : 'Yok'}</div><div>Uçuş süresi</div><div>${r.minutes.toFixed(1)} dk</div></div>
      </div><div>${extra}</div></div></div>
      <div class="scr-foot"><button class="btn" data-a="rp">🎬 Tekrar izle</button><button class="btn" data-a="re">Yeniden dene</button><button class="btn primary" data-a="x">${s.mode === 'cargo' ? 'Kariyere dön' : 'Menü'}</button></div></div>`);
    e.querySelector<HTMLButtonElement>('[data-a="rp"]')!.onclick = () => { this.close(); onReplay(); };
    e.querySelector<HTMLButtonElement>('[data-a="re"]')!.onclick = () => { this.close(); onRestart(); };
    e.querySelector<HTMLButtonElement>('[data-a="x"]')!.onclick = () => { this.close(); onExit(); };
    this.show(e);
    void haversine;
  }
}
