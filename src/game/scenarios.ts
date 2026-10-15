// Emergency scenarios (Acil Durum). Every scenario starts airborne with an engine failure (single or all),
// plus complications. Some are inspired by famous real incidents, described generically.
import type { WeatherState } from '../world/weather';

export type EngFail = 'one' | 'all' | 'asym2';
export interface ScenarioStart {
  apt: string;            // reference airport
  end?: string;           // runway end ident → start on that runway's extended centreline (final)
  dist: number;           // km from airport (or threshold when `end` given)
  bearing?: number;       // deg from airport to start point (ignored with `end`)
  altFt: number;          // ft MSL (AGL added on top of runway elevation for finals)
  hdg?: number;           // deg; default: towards the airport / runway heading
  kt: number;
  climb?: boolean;        // just after take-off (bird strike etc.)
}
export interface Scenario {
  id: string; name: string; desc: string; aircraft: string; engines: EngFail; start: ScenarioStart;
  weather?: Partial<WeatherState>;
  fire?: boolean; fuelLeak?: number; fuelKg?: number; hydraulics?: boolean; gearJam?: boolean; pitot?: boolean; electrics?: boolean;
  wingLost?: -1 | 1; tailDamage?: number; failDelay?: number; inspired?: string; tags: string[]; pax?: number;
}

export const SCENARIOS: Scenario[] = [
  { id: 'kus', name: 'Kuş Sürüsü', desc: 'Kalkıştan hemen sonra kuş sürüsüne girdiniz, iki motor da durdu. Pist geride, altınızda şehir var. Denize iniş bir seçenek olabilir.', aircraft: 'a320', engines: 'all',
    start: { apt: 'LTBA', bearing: 70, dist: 5, altFt: 2900, hdg: 60, kt: 210, climb: true }, inspired: 'Nehre iniş yapılan ünlü olay', tags: ['şehir', 'deniz', 'kuş'] },
  { id: 'suzulme', name: 'Yakıtsız Süzülme', desc: 'Yakıt ölçüm hatası yüzünden seyirde yakıt bitti. Tüm motorlar kapandı, yüksekten uzun bir süzülme yapacaksınız. Menzildeki en uygun pisti seçin.', aircraft: 'b763', engines: 'all',
    start: { apt: 'LTBG', bearing: 20, dist: 70, altFt: 35000, kt: 280 }, fuelKg: 0, inspired: 'Yakıtı biten ve eski bir askeri piste süzülerek inen ünlü olay', tags: ['süzülme', 'yakıt'] },
  { id: 'v1', name: 'Kalkışta Motor Kaybı', desc: 'İstanbul Havalimanı\'ndan kalkıştan hemen sonra 1 numaralı motor arızalandı. Asimetrik itkiyi rudder ile dengeleyip geri dönün.', aircraft: 'b738', engines: 'one',
    start: { apt: 'LTFM', bearing: 355, dist: 4, altFt: 1400, hdg: 354, kt: 165, climb: true }, tags: ['kalkış'] },
  { id: 'yangin', name: 'Marmara Üzerinde Yangın', desc: 'Motor yangını alarmı çalıyor. Yangın kolunu çekip söndürün, sonra en yakın piste dönün.', aircraft: 'a321', engines: 'one',
    start: { apt: 'LTFJ', bearing: 220, dist: 35, altFt: 11000, kt: 290 }, fire: true, tags: ['yangın', 'deniz'] },
  { id: 'sis', name: 'Gece ve Sis', desc: 'Gece yarısı, görüş 600 m. Tek motorla Çorlu\'ya ILS yaklaşması yapacaksınız.', aircraft: 'a320', engines: 'one',
    start: { apt: 'LTBU', end: '04', dist: 18, altFt: 3000, kt: 180 }, weather: { hour: 1, visibility: 600, cloud: 0.9, windKt: 6, windDir: 30 }, tags: ['gece', 'sis'] },
  { id: 'yanruzgar', name: 'Boğaz Yan Rüzgârı', desc: 'Çanakkale\'de 30 kt yan rüzgâr ve hamle var, üstelik bir motor kapalı. Pist 04\'e crab yaparak yaklaşın.', aircraft: 'b738', engines: 'one',
    start: { apt: 'LTBH', end: '04', dist: 15, altFt: 3000, kt: 175 }, weather: { windDir: 130, windKt: 30, gustKt: 12, turb: 0.35 }, tags: ['yan rüzgâr'] },
  { id: 'hidrolik', name: 'Hidrolik Kaybı', desc: 'Hidrolik sistem çöktü. Kumandalar ağır, flaplar çok yavaş, iniş takımı yerçekimiyle açılacak. Üstelik bir motor kapalı.', aircraft: 'a320', engines: 'one',
    start: { apt: 'LTBR', end: '07L', dist: 28, altFt: 6000, kt: 230 }, hydraulics: false, tags: ['hidrolik'] },
  { id: 'gobek', name: 'Teker Açılmıyor', desc: 'İniş takımı sıkıştı ve açılmıyor. Tek motorla gövde üstü (belly) iniş yapmanız gerekiyor. Dikey hızı düşük tutun.', aircraft: 'b738', engines: 'one',
    start: { apt: 'LTBG', end: '36', dist: 20, altFt: 4000, kt: 200 }, gearJam: true, tags: ['gövde üstü'] },
  { id: 'dag', name: 'Uludağ Üzerinde', desc: 'Dağların üzerinde tüm motorlar durdu. Bursa\'ya ulaşabilecek misiniz, yoksa vadide düz bir alan mı arayacaksınız?', aircraft: 'e190', engines: 'all',
    start: { apt: 'LTBR', bearing: 200, dist: 30, altFt: 12000, hdg: 20, kt: 240 }, tags: ['dağ'] },
  { id: 'karadeniz', name: 'Karadeniz Açıkları', desc: 'Karadeniz üzerinde FL200\'de çift motor arızası. Kıyıya dönebilir misiniz?', aircraft: 'a321', engines: 'all',
    start: { apt: 'LTFM', bearing: 10, dist: 55, altFt: 20000, hdg: 190, kt: 270 }, tags: ['deniz'] },
  { id: 'sehir', name: 'İstanbul Üzerinde', desc: 'Şehrin tam üzerinde iki motor da durdu. Yakında Atatürk ve Sabiha Gökçen var, Boğaz da bir seçenek.', aircraft: 'a320', engines: 'all',
    start: { apt: 'LTBA', bearing: 75, dist: 16, altFt: 6000, hdg: 250, kt: 230 }, tags: ['şehir'] },
  { id: 'sizinti', name: 'Yakıt Sızıntısı', desc: 'Sol tankta yakıt sızıntısı var ve tek motor çalışıyor. Yakıt hızla azalıyor, hemen bir karar verin.', aircraft: 'b38m', engines: 'one',
    start: { apt: 'LTBQ', bearing: 250, dist: 60, altFt: 15000, kt: 270 }, fuelLeak: 8, fuelKg: 3500, tags: ['yakıt'] },
  { id: 'gecedeniz', name: 'Gece Denize İniş', desc: 'Gece, Marmara Denizi üzerinde tüm motorlar durdu. Pistler menzil dışında olabilir. Teker yukarıda, kanatlar düz ve yavaş bir alçalmayla denize inin.', aircraft: 'a333', engines: 'all',
    start: { apt: 'LTBG', bearing: 60, dist: 45, altFt: 5000, hdg: 90, kt: 220 }, weather: { hour: 22, visibility: 15000 }, tags: ['gece', 'deniz', 'su'] },
  { id: 'pitot', name: 'Güvenilmez Hız', desc: 'Pitot borusu tıkandı, hız göstergesine güvenemezsiniz. Uçuşu pitch ve güç ayarıyla sürdürün. Bir motor da kapalı.', aircraft: 'b738', engines: 'one',
    start: { apt: 'LTFJ', end: '06L', dist: 30, altFt: 7000, kt: 230 }, pitot: false, tags: ['pitot'] },
  { id: 'elektrik', name: 'Elektrik Arızası', desc: 'Gece elektrik sistemi çöktü, sadece yedek göstergeler çalışıyor. Bir motor da kapalı.', aircraft: 'a320', engines: 'one',
    start: { apt: 'LTFM', end: '35L', dist: 22, altFt: 4000, kt: 210 }, electrics: false, weather: { hour: 23 }, tags: ['gece', 'elektrik'] },
  { id: 'kanat', name: 'Kopuk Kanat Ucu', desc: 'Havada çarpışma sonrası sol kanat ucu koptu ve bir motor kaybedildi. Sert sağ aileron ve rudder ile düz tutun, hemen inin.', aircraft: 'b738', engines: 'one',
    start: { apt: 'LTBU', end: '22', dist: 20, altFt: 4500, kt: 220 }, wingLost: -1, tags: ['hasar'] },
  { id: 'kuyruk', name: 'Kuyruk Hasarı', desc: 'Kuyruk yüzeyleri hasar gördü, yunuslama kontrolü zayıf. Gazla pitch kontrolü yapmanız gerekebilir. Bir motor kapalı.', aircraft: 'a320', engines: 'one',
    start: { apt: 'LTBA', end: '05', dist: 25, altFt: 5000, kt: 220 }, tailDamage: 0.7, tags: ['hasar'] },
  { id: 'agir', name: 'Ağır 777', desc: 'Tam dolu bir 777-300ER ile Çanakkale Boğazı üzerinde tek motor arızası. Ağır uçağı kontrol edip LTBH\'ye ya da başka bir piste ulaşın.', aircraft: 'b77w', engines: 'one',
    start: { apt: 'LTBH', bearing: 60, dist: 40, altFt: 9000, kt: 260 }, fuelKg: 90000, tags: ['ağır'] },
  { id: 'cessna', name: 'Cessna Tarla İnişi', desc: 'Küçük bir Cessna\'nın motoru durdu. Yakında pist yok, düz bir tarla seçip rüzgâra karşı inin.', aircraft: 'c172', engines: 'all',
    start: { apt: 'LTBU', bearing: 300, dist: 25, altFt: 3500, kt: 95 }, tags: ['tarla'] },
  { id: 'atr', name: 'Kocaeli Tepeleri', desc: 'ATR 72\'de iki motorda da alev söndü. Tepeler arasında Cengiz Topel\'e süzülmeyi deneyin.', aircraft: 'atr72', engines: 'all',
    start: { apt: 'LTBQ', bearing: 150, dist: 18, altFt: 6500, hdg: 330, kt: 180 }, weather: { cloud: 0.6, turb: 0.25 }, tags: ['dağ'] },
  { id: 'jumbo', name: 'Jumbo İki Motor', desc: '747-8\'de aynı taraftaki iki motor kaybedildi. Çok güçlü asimetri var.', aircraft: 'b748', engines: 'asym2',
    start: { apt: 'LTFM', end: '34L', dist: 30, altFt: 6000, kt: 230 }, tags: ['asimetri'] },
  { id: 'edremit', name: 'Edremit Dağları', desc: 'Kaz Dağları yakınında hamleli rüzgâr altında tek motorla Koca Seyit\'e yaklaşma.', aircraft: 'e190', engines: 'one',
    start: { apt: 'LTFD', end: '05', dist: 22, altFt: 5000, kt: 210 }, weather: { windDir: 20, windKt: 22, gustKt: 15, turb: 0.4 }, tags: ['dağ', 'rüzgâr'] },
  { id: 'kisa', name: 'Kısa Pist', desc: 'İş jetinde iki motor da durdu. Yalnızca kısa askerî pist Yalova menzilde.', aircraft: 'bizjet', engines: 'all',
    start: { apt: 'LTBP', bearing: 90, dist: 22, altFt: 7000, hdg: 270, kt: 220 }, tags: ['kısa pist'] }
];

export function randomScenario(seed = Math.random()): Scenario {
  let s = Math.floor(seed * 2 ** 31) || 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const apts = ['LTFM', 'LTFJ', 'LTBA', 'LTBU', 'LTBR', 'LTBQ', 'LTBH', 'LTBG', 'LTBF', 'LTFD'];
  const ac = pick(['a320', 'b738', 'a321', 'e190', 'b38m', 'a333', 'b77w', 'atr72', 'dh8d', 'crj9']);
  const engines: EngFail = rnd() < 0.5 ? 'one' : 'all';
  const dist = 12 + rnd() * 50;
  const altFt = Math.round((engines === 'all' ? dist * 900 : 3000 + dist * 120) / 500) * 500;
  const comps = ['fire', 'leak', 'hyd', 'gear', 'night', 'fog', 'cross', 'pitot', 'none', 'none'];
  const c1 = pick(comps), c2 = rnd() < 0.35 ? pick(comps) : 'none';
  const has = (k: string) => c1 === k || c2 === k;
  const sc: Scenario = {
    id: 'rnd-' + Math.floor(seed * 1e6), name: 'Rastgele Acil Durum', aircraft: ac, engines,
    desc: '', start: { apt: pick(apts), bearing: Math.floor(rnd() * 360), dist, altFt: Math.max(2500, Math.min(25000, altFt)), kt: 220 + Math.floor(rnd() * 40) },
    tags: [], weather: {}
  };
  if (has('fire')) sc.fire = true;
  if (has('leak')) { sc.fuelLeak = 5; sc.fuelKg = 4000; }
  if (has('hyd')) sc.hydraulics = false;
  if (has('gear')) sc.gearJam = true;
  if (has('night')) sc.weather!.hour = 23;
  if (has('fog')) { sc.weather!.visibility = 900; sc.weather!.cloud = 0.9; }
  if (has('cross')) { sc.weather!.windKt = 25; sc.weather!.gustKt = 10; sc.weather!.windDir = Math.floor(rnd() * 360); }
  if (has('pitot')) sc.pitot = false;
  const parts = [engines === 'all' ? 'Tüm motorlar durdu' : 'Bir motor arızalı'];
  if (sc.fire) parts.push('motor yangını'); if (sc.fuelLeak) parts.push('yakıt sızıntısı'); if (sc.hydraulics === false) parts.push('hidrolik kaybı');
  if (sc.gearJam) parts.push('iniş takımı sıkışık'); if (sc.weather!.hour === 23) parts.push('gece'); if (sc.weather!.visibility) parts.push('sis');
  if (sc.weather!.windKt) parts.push('kuvvetli rüzgâr'); if (sc.pitot === false) parts.push('güvenilmez hız');
  sc.desc = parts.join(', ') + '. En uygun iniş yerini bulun.';
  sc.tags = parts.slice(1);
  return sc;
}
