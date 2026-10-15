// Yük Modu: career with money, contracts, hangar, planes (cheap → expensive), costs and earnings.
import { store, Career, OwnedPlane } from '../core/store';
import { FREIGHTERS, typeById } from '../sim/aircraftData';
import { haversine } from '../core/geo';
import type { Airport } from '../world/airports';
import { mulberry } from '../world/airports';

export interface Contract {
  id: string; from: string; to: string; cargo: string; icon: string; kg: number; distKm: number;
  deadlineMin: number; pay: number; urgent: boolean; fragile: boolean; minRunway: number;
}
const CARGO = [
  { n: 'Tıbbi malzeme', i: '💊', urgent: 0.7, fragile: true, rate: 1.6 },
  { n: 'Elektronik', i: '📦', urgent: 0.3, fragile: true, rate: 1.35 },
  { n: 'Taze meyve-sebze', i: '🍊', urgent: 0.6, fragile: false, rate: 1.15 },
  { n: 'Tekstil', i: '🧵', urgent: 0.1, fragile: false, rate: 0.9 },
  { n: 'Otomotiv parçaları', i: '⚙️', urgent: 0.25, fragile: false, rate: 1.0 },
  { n: 'Posta / kargo kolisi', i: '✉️', urgent: 0.5, fragile: false, rate: 1.1 },
  { n: 'Canlı hayvan', i: '🐎', urgent: 0.5, fragile: true, rate: 1.5 },
  { n: 'Endüstriyel makine', i: '🏗️', urgent: 0.1, fragile: false, rate: 0.85 },
  { n: 'Çiçek', i: '💐', urgent: 0.8, fragile: true, rate: 1.4 },
  { n: 'İnşaat malzemesi', i: '🧱', urgent: 0.05, fragile: false, rate: 0.75 }
];
export const FUEL_PRICE = 1.1;     // ₺ per kg
export const START_MONEY = 30000;

export function newCareer(): Career {
  const p: OwnedPlane = { id: 'p1', type: 'c208f', condition: 1, fuelKg: 600, at: 'LTBA', hours: 0 };
  return { money: START_MONEY, location: 'LTBA', planes: [p], active: 'p1', deliveries: 0, earned: 0, contracts: [], contractsAt: 0, seed: Math.floor(Math.random() * 1e9) };
}
export function career(): Career {
  if (!store.data.career) { store.data.career = newCareer(); persist(); }
  return store.data.career!;
}
export const persist = () => { try { localStorage.setItem('acilinis.save.v1', JSON.stringify(store.data)); } catch { /* */ } };
export const activePlane = () => { const c = career(); return c.planes.find(p => p.id === c.active) ?? c.planes[0]; };
export const money = (v: number) => '₺' + Math.round(v).toLocaleString('tr-TR');

export function landingFee(a: Airport, mtow: number) { return Math.round((a.type === 2 ? 900 : a.type === 1 ? 450 : 200) + mtow * 0.006); }
export function repairCost(p: OwnedPlane) { const t = typeById(p.type); return Math.round((1 - p.condition) * Math.max(40000, (t.price ?? 150000)) * 0.35); }
export function tripFuel(typeId: string, distKm: number) {
  const t = typeById(typeId);
  const perKm = t.kind === 'jet' ? t.mtow * 0.000055 + 1.2 : t.mtow * 0.00004 + 0.25;
  return Math.round(perKm * distKm * 1.0 + t.mtow * 0.012 + perKm * 120); // trip + taxi/climb + reserve
}

export function genContracts(here: Airport, airports: Airport[], planeType: string, now = Date.now()): Contract[] {
  const c = career();
  const t = typeById(planeType);
  const seed = (c.seed + Math.floor(now / (15 * 60 * 1000)) * 7919 + here.ident.charCodeAt(2) * 131) >>> 0;
  const rnd = mulberry(seed);
  const dests = airports.filter(a => a.ident !== here.ident);
  const out: Contract[] = [];
  const maxPay = t.payloadMax;
  for (let i = 0; i < 9; i++) {
    const d = dests[Math.floor(rnd() * dests.length)];
    if (!d) break;
    const cg = CARGO[Math.floor(rnd() * CARGO.length)];
    const distKm = haversine(here.lat, here.lon, d.lat, d.lon) / 1000;
    const urgent = rnd() < cg.urgent;
    const heavy = rnd() < 0.3;
    const kg = Math.round(Math.max(150, maxPay * (heavy ? 0.7 + rnd() * 0.3 : 0.2 + rnd() * 0.5)) / 10) * 10;
    const cruiseKmh = t.kind === 'jet' ? 650 : t.kind === 'turboprop' ? 420 : 220;
    const deadlineMin = Math.round((distKm / cruiseKmh * 60 + 18) * (urgent ? 1.15 : 1.8));
    const pay = Math.round((600 + kg / 1000 * distKm * 38 * cg.rate + kg * 0.45) * (urgent ? 1.55 : 1) * (heavy ? 1.1 : 1) / 10) * 10;
    const minRunway = Math.min(...d.runways.map(r => r.length)) ;
    out.push({ id: `${here.ident}-${i}-${seed % 1000}`, from: here.ident, to: d.ident, cargo: cg.n, icon: cg.i, kg, distKm: Math.round(distKm), deadlineMin, pay, urgent, fragile: cg.fragile, minRunway: Math.max(...d.runways.map(r => r.length)) || minRunway });
  }
  return out.sort((a, b) => b.pay - a.pay);
}

export function buyPlane(typeId: string): string | null {
  const c = career(); const t = FREIGHTERS.find(f => f.id === typeId);
  if (!t || (t.price ?? 0) > c.money) return 'Yetersiz bakiye';
  c.money -= t.price ?? 0;
  const id = 'p' + (Date.now() % 1e8);
  c.planes.push({ id, type: t.id, condition: 1, fuelKg: t.fuelMax * 0.2, at: c.location, hours: 0 });
  c.active = id;
  persist();
  return null;
}
export function repair(p: OwnedPlane): string | null {
  const c = career(); const cost = repairCost(p);
  if (cost > c.money) return 'Yetersiz bakiye';
  c.money -= cost; p.condition = 1; persist(); return null;
}

export interface DeliveryResult { pay: number; bonus: number; fuelCost: number; fee: number; repair: number; damagePct: number; net: number; late: boolean; landing: string; delivered: boolean }
export function settle(ct: Contract, opts: { minutes: number; vsFpm: number; crashed: boolean; atDest: boolean; fuelUsed: number; condLoss: number; dest: Airport | undefined; mtow: number }): DeliveryResult {
  const c = career(); const p = activePlane();
  const late = opts.minutes > ct.deadlineMin;
  let damage = 0, landing = 'Yumuşak';
  const v = Math.abs(opts.vsFpm);
  if (opts.crashed) { damage = 1; landing = 'Kaza'; }
  else if (v > 900) { damage = ct.fragile ? 0.6 : 0.35; landing = 'Çok sert'; }
  else if (v > 600) { damage = ct.fragile ? 0.25 : 0.1; landing = 'Sert'; }
  else if (v > 300) { damage = ct.fragile ? 0.05 : 0; landing = 'Normal'; }
  const delivered = opts.atDest && !opts.crashed;
  let pay = delivered ? ct.pay * (1 - damage) * (late ? 0.6 : 1) : 0;
  const bonus = delivered && !late && v < 250 ? Math.round(ct.pay * 0.12) : 0;
  const fuelCost = Math.round(opts.fuelUsed * FUEL_PRICE);
  const fee = opts.dest ? landingFee(opts.dest, opts.mtow) : 0;
  const condLoss = Math.min(1, opts.condLoss + (v > 600 ? (v - 600) / 3000 : 0) + (opts.crashed ? 0.85 : 0));
  p.condition = Math.max(0.05, p.condition - condLoss);
  const rep = repairCost(p);
  pay = Math.round(pay);
  const net = pay + bonus - fuelCost - fee;
  c.money += net;
  c.earned += Math.max(0, net);
  if (delivered) { c.deliveries++; c.location = ct.to; p.at = ct.to; }
  persist();
  return { pay, bonus, fuelCost, fee, repair: rep, damagePct: Math.round(damage * 100), net, late, landing, delivered };
}
