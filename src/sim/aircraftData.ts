// Aircraft database (generic types, accurate-ish public specs).
export type EngineKind = 'jet' | 'turboprop' | 'piston';
export interface FlapSetting { name: string; dCL: number; dCLmax: number; dCD: number; vfe: number }
export interface AircraftType {
  id: string; name: string; short: string; maker: string; kind: EngineKind;
  engines: number; thrust: number;       // N per engine (jets) / static thrust for props
  power?: number;                         // kW per engine (props)
  enginePos: [number, number, number][]; // body (x right, y up, z back) relative to CG, m
  oew: number; mtow: number; mlw: number; fuelMax: number; payloadMax: number; seats: number;
  S: number; b: number; c: number; sweep: number; length: number; dia: number; height: number;
  wing: 'low' | 'high'; tail: 'conv' | 'T' | 'twin'; engineMount: 'wing' | 'tail' | 'nose';
  CLmax: number; CD0: number; e: number; CLa: number;
  flaps: FlapSetting[];
  vmo: number; mmo: number; ceiling: number; vr: number; // kt (vr at mtow ~)
  fbw: boolean; deck?: 'double' | 'hump';
  livery: [string, string, string]; // body, tail, stripe
  freighter?: boolean; price?: number; baseOf?: string; tsfc: number; spool: number;
  gearTrack: number; noseGearZ: number; mainGearZ: number; gearH: number;
}

const jetFlaps = (vfes: number[], cl = [0.32, 0.55, 0.78, 1.05], cd = [0.012, 0.028, 0.05, 0.085]): FlapSetting[] => [
  { name: '0', dCL: 0, dCLmax: 0, dCD: 0, vfe: 999 },
  { name: '1', dCL: cl[0] * 0.55, dCLmax: cl[0], dCD: cd[0], vfe: vfes[0] },
  { name: '2', dCL: cl[1] * 0.6, dCLmax: cl[1], dCD: cd[1], vfe: vfes[1] },
  { name: '3', dCL: cl[2] * 0.62, dCLmax: cl[2], dCD: cd[2], vfe: vfes[2] },
  { name: 'FULL', dCL: cl[3] * 0.64, dCLmax: cl[3], dCD: cd[3], vfe: vfes[3] }
];
const propFlaps = (vfes: number[]): FlapSetting[] => [
  { name: '0', dCL: 0, dCLmax: 0, dCD: 0, vfe: 999 },
  { name: '10', dCL: 0.18, dCLmax: 0.28, dCD: 0.01, vfe: vfes[0] },
  { name: '20', dCL: 0.36, dCLmax: 0.48, dCD: 0.025, vfe: vfes[1] },
  { name: '30', dCL: 0.55, dCLmax: 0.7, dCD: 0.05, vfe: vfes[2] }
];

const base = (o: Partial<AircraftType> & Pick<AircraftType, 'id' | 'name'>): AircraftType => ({
  short: o.id.toUpperCase(), maker: '', kind: 'jet', engines: 2, thrust: 120000, enginePos: [], oew: 42000, mtow: 78000, mlw: 66000,
  fuelMax: 19000, payloadMax: 20000, seats: 180, S: 122.6, b: 35.8, c: 4.2, sweep: 25, length: 37.6, dia: 3.95, height: 11.8,
  wing: 'low', tail: 'conv', engineMount: 'wing', CLmax: 1.45, CD0: 0.0215, e: 0.8, CLa: 5.0, flaps: jetFlaps([230, 215, 195, 177]),
  vmo: 340, mmo: 0.82, ceiling: 39000, vr: 145, fbw: false, livery: ['#f4f6f8', '#c8102e', '#1d3557'], tsfc: 1.65e-5, spool: 5.5,
  gearTrack: 7.6, noseGearZ: -12.6, mainGearZ: 1.2, gearH: 2.6,
  ...o
});
const twinWing = (span: number, y = -1.6, z = -1.8): [number, number, number][] => [[-span * 0.17, y, z], [span * 0.17, y, z]];
const quadWing = (span: number, y = -1.8, z = -2): [number, number, number][] => [[-span * 0.36, y, z + 4], [-span * 0.19, y, z], [span * 0.19, y, z], [span * 0.36, y, z + 4]];

export const AIRCRAFT: AircraftType[] = [
  base({ id: 'c172', name: 'Cessna 172', short: 'C172', maker: 'Cessna', kind: 'piston', engines: 1, thrust: 3200, power: 120, enginePos: [[0, 0.1, -3.2]],
    oew: 770, mtow: 1111, mlw: 1111, fuelMax: 150, payloadMax: 320, seats: 3, S: 16.2, b: 11, c: 1.5, sweep: 0, length: 8.3, dia: 1.25, height: 2.7,
    wing: 'high', engineMount: 'nose', CLmax: 1.55, CD0: 0.031, e: 0.75, CLa: 4.8, flaps: propFlaps([110, 85, 85]), vmo: 163, mmo: 0.3, ceiling: 14000, vr: 55,
    livery: ['#f6f6f2', '#b3262e', '#203a6b'], tsfc: 0, spool: 1.2, gearTrack: 2.5, noseGearZ: -1.9, mainGearZ: 0.35, gearH: 0.95 }),
  base({ id: 'c208', name: 'Cessna 208 Caravan', short: 'C208', maker: 'Cessna', kind: 'turboprop', engines: 1, thrust: 9500, power: 503, enginePos: [[0, 0.1, -4.6]],
    oew: 2145, mtow: 3970, mlw: 3870, fuelMax: 1010, payloadMax: 1400, seats: 9, S: 25.96, b: 15.88, c: 1.7, sweep: 0, length: 11.5, dia: 1.65, height: 4.5,
    wing: 'high', engineMount: 'nose', CLmax: 1.6, CD0: 0.034, e: 0.76, CLa: 4.9, flaps: propFlaps([175, 150, 125]), vmo: 175, mmo: 0.35, ceiling: 25000, vr: 70,
    livery: ['#f2f2ee', '#14456b', '#e0a526'], tsfc: 0, spool: 2.2, gearTrack: 3.6, noseGearZ: -3.4, mainGearZ: 0.4, gearH: 1.2 }),
  base({ id: 'atr72', name: 'ATR 72-600', short: 'ATR72', maker: 'ATR', kind: 'turboprop', engines: 2, thrust: 38000, power: 2050, enginePos: [[-4.1, 0.6, -3.4], [4.1, 0.6, -3.4]],
    oew: 13500, mtow: 23000, mlw: 22350, fuelMax: 5000, payloadMax: 7500, seats: 70, S: 61, b: 27.05, c: 2.3, sweep: 3, length: 27.2, dia: 2.6, height: 7.7,
    wing: 'high', tail: 'T', CLmax: 1.55, CD0: 0.027, e: 0.8, CLa: 5.2, flaps: propFlaps([185, 170, 150]), vmo: 250, mmo: 0.55, ceiling: 25000, vr: 105,
    livery: ['#f5f6f7', '#0b6a3c', '#0b6a3c'], tsfc: 0, spool: 2.6, gearTrack: 4.1, noseGearZ: -9.6, mainGearZ: 1.0, gearH: 1.6 }),
  base({ id: 'dh8d', name: 'Dash 8 Q400', short: 'DH8D', maker: 'De Havilland', kind: 'turboprop', engines: 2, thrust: 58000, power: 3780, enginePos: [[-4.2, 0.4, -4.4], [4.2, 0.4, -4.4]],
    oew: 17100, mtow: 29260, mlw: 28000, fuelMax: 5300, payloadMax: 8700, seats: 78, S: 63.1, b: 28.4, c: 2.4, sweep: 3, length: 32.8, dia: 2.7, height: 8.3,
    wing: 'high', tail: 'T', CLmax: 1.55, CD0: 0.026, e: 0.8, CLa: 5.2, flaps: [{ name: '0', dCL: 0, dCLmax: 0, dCD: 0, vfe: 999 }, { name: '5', dCL: 0.15, dCLmax: 0.25, dCD: 0.01, vfe: 200 }, { name: '10', dCL: 0.3, dCLmax: 0.42, dCD: 0.02, vfe: 181 }, { name: '15', dCL: 0.42, dCLmax: 0.56, dCD: 0.035, vfe: 172 }, { name: '35', dCL: 0.62, dCLmax: 0.8, dCD: 0.07, vfe: 158 }],
    vmo: 286, mmo: 0.6, ceiling: 27000, vr: 115, livery: ['#f5f6f7', '#1f4e9c', '#d62828'], tsfc: 0, spool: 2.6, gearTrack: 8.8, noseGearZ: -12.5, mainGearZ: 1.0, gearH: 1.9 }),
  base({ id: 'crj9', name: 'CRJ-900', short: 'CRJ9', maker: 'Bombardier', engines: 2, thrust: 64500, enginePos: [[-2.3, 1.1, 10.5], [2.3, 1.1, 10.5]],
    oew: 21800, mtow: 38300, mlw: 34000, fuelMax: 8800, payloadMax: 10200, seats: 90, S: 70.6, b: 24.9, c: 3.1, sweep: 26, length: 36.2, dia: 2.7, height: 7.5,
    tail: 'T', engineMount: 'tail', CLmax: 1.38, CD0: 0.023, flaps: jetFlaps([230, 220, 200, 170]), vmo: 335, mmo: 0.85, ceiling: 41000, vr: 140,
    livery: ['#f4f5f6', '#3b2a8f', '#3b2a8f'], gearTrack: 4.1, noseGearZ: -14.2, mainGearZ: 1.0, gearH: 1.7, spool: 4.8 }),
  base({ id: 'e190', name: 'Embraer E190', short: 'E190', maker: 'Embraer', engines: 2, thrust: 89000, enginePos: twinWing(28.7, -1.3, -1.4),
    oew: 28000, mtow: 51800, mlw: 44000, fuelMax: 13000, payloadMax: 13000, seats: 100, S: 92.5, b: 28.7, c: 3.6, sweep: 23, length: 36.2, dia: 3.0, height: 10.6,
    CLmax: 1.42, CD0: 0.0225, flaps: jetFlaps([230, 215, 200, 165]), vmo: 320, mmo: 0.82, ceiling: 41000, vr: 135, fbw: true,
    livery: ['#f5f6f7', '#0067b1', '#00a3e0'], gearTrack: 5.9, noseGearZ: -13.5, mainGearZ: 1.0, gearH: 2.0 }),
  base({ id: 'a320', name: 'Airbus A320', short: 'A320', maker: 'Airbus', engines: 2, thrust: 120000, enginePos: twinWing(35.8),
    oew: 42600, mtow: 78000, mlw: 66000, fuelMax: 19000, payloadMax: 20000, seats: 180, S: 122.6, b: 35.8, c: 4.29, sweep: 25, length: 37.6, dia: 3.95, height: 11.8,
    CLmax: 1.45, CD0: 0.0215, flaps: jetFlaps([230, 215, 200, 177]), vmo: 350, mmo: 0.82, ceiling: 39000, vr: 145, fbw: true,
    livery: ['#f4f6f8', '#d71920', '#1d3557'], gearTrack: 7.6, noseGearZ: -12.6, mainGearZ: 1.2, gearH: 2.6 }),
  base({ id: 'a321', name: 'Airbus A321', short: 'A321', maker: 'Airbus', engines: 2, thrust: 147000, enginePos: twinWing(35.8),
    oew: 48500, mtow: 93500, mlw: 77800, fuelMax: 19000, payloadMax: 25000, seats: 220, S: 122.4, b: 35.8, c: 4.29, sweep: 25, length: 44.5, dia: 3.95, height: 11.8,
    CLmax: 1.48, CD0: 0.0222, flaps: jetFlaps([235, 225, 195, 186], [0.34, 0.6, 0.84, 1.12]), vmo: 350, mmo: 0.82, ceiling: 39000, vr: 152, fbw: true,
    livery: ['#f4f6f8', '#0a3d91', '#e63946'], gearTrack: 7.6, noseGearZ: -16.2, mainGearZ: 1.4, gearH: 2.6 }),
  base({ id: 'b738', name: 'Boeing 737-800', short: 'B738', maker: 'Boeing', engines: 2, thrust: 121000, enginePos: twinWing(35.8, -1.3, -2.4),
    oew: 41400, mtow: 79000, mlw: 66300, fuelMax: 20800, payloadMax: 20000, seats: 189, S: 124.6, b: 35.8, c: 3.96, sweep: 25, length: 39.5, dia: 3.76, height: 12.5,
    CLmax: 1.42, CD0: 0.0218, flaps: [{ name: '0', dCL: 0, dCLmax: 0, dCD: 0, vfe: 999 }, { name: '1', dCL: 0.18, dCLmax: 0.3, dCD: 0.01, vfe: 250 }, { name: '5', dCL: 0.32, dCLmax: 0.5, dCD: 0.02, vfe: 250 }, { name: '15', dCL: 0.48, dCLmax: 0.72, dCD: 0.04, vfe: 200 }, { name: '30', dCL: 0.66, dCLmax: 1.02, dCD: 0.075, vfe: 175 }],
    vmo: 340, mmo: 0.82, ceiling: 41000, vr: 145, livery: ['#f4f6f8', '#1d3557', '#e9c46a'], gearTrack: 5.7, noseGearZ: -14.3, mainGearZ: 1.2, gearH: 2.2 }),
  base({ id: 'b38m', name: 'Boeing 737 MAX 8', short: 'B38M', maker: 'Boeing', engines: 2, thrust: 130000, enginePos: twinWing(35.9, -1.2, -2.8),
    oew: 45000, mtow: 82200, mlw: 69300, fuelMax: 20700, payloadMax: 21000, seats: 189, S: 127, b: 35.9, c: 3.96, sweep: 25, length: 39.5, dia: 3.76, height: 12.3,
    CLmax: 1.44, CD0: 0.021, flaps: [{ name: '0', dCL: 0, dCLmax: 0, dCD: 0, vfe: 999 }, { name: '1', dCL: 0.18, dCLmax: 0.3, dCD: 0.01, vfe: 250 }, { name: '5', dCL: 0.32, dCLmax: 0.5, dCD: 0.02, vfe: 250 }, { name: '15', dCL: 0.48, dCLmax: 0.72, dCD: 0.04, vfe: 200 }, { name: '30', dCL: 0.66, dCLmax: 1.02, dCD: 0.075, vfe: 175 }],
    vmo: 340, mmo: 0.82, ceiling: 41000, vr: 148, tsfc: 1.45e-5, livery: ['#f4f6f8', '#2a9d8f', '#264653'], gearTrack: 5.7, noseGearZ: -14.3, mainGearZ: 1.2, gearH: 2.2 }),
  base({ id: 'b752', name: 'Boeing 757-200', short: 'B752', maker: 'Boeing', engines: 2, thrust: 178000, enginePos: twinWing(38, -1.8, -3),
    oew: 58000, mtow: 115680, mlw: 89800, fuelMax: 33800, payloadMax: 26000, seats: 200, S: 185.25, b: 38.05, c: 5.6, sweep: 25, length: 47.3, dia: 3.76, height: 13.6,
    CLmax: 1.46, CD0: 0.021, flaps: jetFlaps([240, 220, 190, 162], [0.36, 0.62, 0.86, 1.15]), vmo: 350, mmo: 0.86, ceiling: 42000, vr: 140,
    livery: ['#f4f6f8', '#6a040f', '#9d0208'], gearTrack: 7.3, noseGearZ: -18.3, mainGearZ: 1.6, gearH: 2.9 }),
  base({ id: 'b763', name: 'Boeing 767-300ER', short: 'B763', maker: 'Boeing', engines: 2, thrust: 270000, enginePos: twinWing(47.6, -2.0, -4),
    oew: 90000, mtow: 186880, mlw: 145150, fuelMax: 73000, payloadMax: 40000, seats: 260, S: 283.3, b: 47.6, c: 6.98, sweep: 31.5, length: 54.9, dia: 5.03, height: 15.9,
    CLmax: 1.45, CD0: 0.0195, flaps: jetFlaps([250, 230, 195, 165]), vmo: 360, mmo: 0.86, ceiling: 43100, vr: 155,
    livery: ['#f4f6f8', '#003049', '#f77f00'], gearTrack: 9.3, noseGearZ: -21, mainGearZ: 1.8, gearH: 3.2, spool: 6 }),
  base({ id: 'b77w', name: 'Boeing 777-300ER', short: 'B77W', maker: 'Boeing', engines: 2, thrust: 513000, enginePos: twinWing(64.8, -2.6, -5),
    oew: 167800, mtow: 351500, mlw: 251300, fuelMax: 145500, payloadMax: 69000, seats: 396, S: 436.8, b: 64.8, c: 8.2, sweep: 31.6, length: 73.9, dia: 6.2, height: 18.5,
    CLmax: 1.45, CD0: 0.019, flaps: [{ name: '0', dCL: 0, dCLmax: 0, dCD: 0, vfe: 999 }, { name: '1', dCL: 0.18, dCLmax: 0.3, dCD: 0.01, vfe: 255 }, { name: '5', dCL: 0.32, dCLmax: 0.52, dCD: 0.02, vfe: 235 }, { name: '15', dCL: 0.5, dCLmax: 0.76, dCD: 0.04, vfe: 215 }, { name: '30', dCL: 0.68, dCLmax: 1.05, dCD: 0.075, vfe: 175 }],
    vmo: 330, mmo: 0.89, ceiling: 43100, vr: 165, fbw: true, livery: ['#f4f6f8', '#c8102e', '#c8102e'], gearTrack: 11, noseGearZ: -28.5, mainGearZ: 2.5, gearH: 3.8, spool: 7 }),
  base({ id: 'b789', name: 'Boeing 787-9', short: 'B789', maker: 'Boeing', engines: 2, thrust: 320000, enginePos: twinWing(60.1, -2.4, -4.5),
    oew: 128850, mtow: 254000, mlw: 192800, fuelMax: 101000, payloadMax: 52000, seats: 290, S: 377, b: 60.1, c: 7.4, sweep: 32.2, length: 62.8, dia: 5.77, height: 17,
    CLmax: 1.47, CD0: 0.0178, flaps: jetFlaps([255, 230, 200, 175]), vmo: 330, mmo: 0.9, ceiling: 43000, vr: 155, fbw: true, tsfc: 1.4e-5,
    livery: ['#f4f6f8', '#14213d', '#fca311'], gearTrack: 9.8, noseGearZ: -23, mainGearZ: 2.2, gearH: 3.4, spool: 6.5 }),
  base({ id: 'a333', name: 'Airbus A330-300', short: 'A333', maker: 'Airbus', engines: 2, thrust: 316000, enginePos: twinWing(60.3, -2.4, -4.5),
    oew: 129400, mtow: 242000, mlw: 187000, fuelMax: 110000, payloadMax: 46000, seats: 300, S: 361.6, b: 60.3, c: 7.26, sweep: 30, length: 63.7, dia: 5.64, height: 16.8,
    CLmax: 1.46, CD0: 0.019, flaps: jetFlaps([240, 215, 196, 180]), vmo: 330, mmo: 0.86, ceiling: 41000, vr: 150, fbw: true,
    livery: ['#f4f6f8', '#7b2cbf', '#3c096c'], gearTrack: 10.7, noseGearZ: -23.5, mainGearZ: 2.1, gearH: 3.4, spool: 6.5 }),
  base({ id: 'a359', name: 'Airbus A350-900', short: 'A359', maker: 'Airbus', engines: 2, thrust: 374000, enginePos: twinWing(64.75, -2.6, -5),
    oew: 142400, mtow: 280000, mlw: 207000, fuelMax: 110000, payloadMax: 53000, seats: 325, S: 442, b: 64.75, c: 7.8, sweep: 31.9, length: 66.8, dia: 5.96, height: 17.05,
    CLmax: 1.47, CD0: 0.0175, flaps: jetFlaps([255, 220, 205, 186]), vmo: 340, mmo: 0.89, ceiling: 43100, vr: 155, fbw: true, tsfc: 1.38e-5,
    livery: ['#f4f6f8', '#005f73', '#0a9396'], gearTrack: 10.6, noseGearZ: -25, mainGearZ: 2.2, gearH: 3.5, spool: 6.5 }),
  base({ id: 'a388', name: 'Airbus A380', short: 'A388', maker: 'Airbus', engines: 4, thrust: 311000, enginePos: quadWing(79.75, -2.6, -6),
    oew: 277000, mtow: 575000, mlw: 394000, fuelMax: 250000, payloadMax: 84000, seats: 555, S: 845, b: 79.75, c: 11.9, sweep: 33.5, length: 72.7, dia: 7.14, height: 24.1,
    CLmax: 1.48, CD0: 0.019, flaps: jetFlaps([263, 222, 196, 182]), vmo: 340, mmo: 0.89, ceiling: 43000, vr: 155, fbw: true, deck: 'double',
    livery: ['#f4f6f8', '#b5838d', '#6d6875'], gearTrack: 14.3, noseGearZ: -27, mainGearZ: 2.5, gearH: 4.0, spool: 7 }),
  base({ id: 'b748', name: 'Boeing 747-8', short: 'B748', maker: 'Boeing', engines: 4, thrust: 296000, enginePos: quadWing(68.4, -2.4, -6),
    oew: 220000, mtow: 447700, mlw: 312000, fuelMax: 193000, payloadMax: 76000, seats: 410, S: 554, b: 68.4, c: 9.6, sweep: 37.5, length: 76.3, dia: 6.5, height: 19.4,
    CLmax: 1.44, CD0: 0.019, flaps: [{ name: '0', dCL: 0, dCLmax: 0, dCD: 0, vfe: 999 }, { name: '1', dCL: 0.17, dCLmax: 0.28, dCD: 0.01, vfe: 280 }, { name: '10', dCL: 0.34, dCLmax: 0.52, dCD: 0.025, vfe: 240 }, { name: '20', dCL: 0.5, dCLmax: 0.75, dCD: 0.045, vfe: 225 }, { name: '30', dCL: 0.68, dCLmax: 1.04, dCD: 0.08, vfe: 180 }],
    vmo: 365, mmo: 0.9, ceiling: 43100, vr: 165, deck: 'hump', livery: ['#f4f6f8', '#e76f51', '#264653'], gearTrack: 11, noseGearZ: -26, mainGearZ: 2.6, gearH: 4.0, spool: 7 }),
  base({ id: 'an225', name: 'Antonov An-225 Mriya', short: 'A225', maker: 'Antonov', engines: 6, thrust: 229000, enginePos: [[-30, -0.8, -4], [-21, -0.8, -5], [-12.5, -0.8, -6], [12.5, -0.8, -6], [21, -0.8, -5], [30, -0.8, -4]],
    oew: 285000, mtow: 640000, mlw: 591700, fuelMax: 300000, payloadMax: 250000, seats: 0, S: 905, b: 88.4, c: 11, sweep: 30, length: 84, dia: 6.4, height: 18.1,
    wing: 'high', tail: 'twin', CLmax: 1.5, CD0: 0.023, flaps: jetFlaps([250, 220, 190, 160]), vmo: 330, mmo: 0.8, ceiling: 36000, vr: 155,
    livery: ['#f2f2f0', '#005bbb', '#ffd500'], gearTrack: 8, noseGearZ: -30, mainGearZ: 2, gearH: 2.6, spool: 8, freighter: true }),
  base({ id: 'bizjet', name: 'İş Jeti (Challenger tipi)', short: 'BJET', maker: 'Genel', engines: 2, thrust: 41000, enginePos: [[-2.0, 0.9, 6.0], [2.0, 0.9, 6.0]],
    oew: 12300, mtow: 21900, mlw: 17700, fuelMax: 9100, payloadMax: 2700, seats: 12, S: 48.3, b: 19.6, c: 2.6, sweep: 25, length: 20.9, dia: 2.7, height: 6.3,
    tail: 'T', engineMount: 'tail', CLmax: 1.42, CD0: 0.022, flaps: jetFlaps([231, 210, 197, 180]), vmo: 348, mmo: 0.85, ceiling: 41000, vr: 125,
    livery: ['#fbfbfb', '#222831', '#c5a572'], gearTrack: 3.2, noseGearZ: -8, mainGearZ: 0.7, gearH: 1.4, spool: 4.2 }),
  base({ id: 'c130', name: 'C-130 Hercules tipi', short: 'C130', maker: 'Lockheed tipi', kind: 'turboprop', engines: 4, thrust: 62000, power: 3460,
    enginePos: [[-12, 0.4, -3.6], [-5.6, 0.4, -3.9], [5.6, 0.4, -3.9], [12, 0.4, -3.6]],
    oew: 34400, mtow: 70300, mlw: 70300, fuelMax: 20000, payloadMax: 19000, seats: 92, S: 162.1, b: 40.4, c: 4.2, sweep: 2, length: 29.8, dia: 4.5, height: 11.6,
    wing: 'high', CLmax: 1.6, CD0: 0.03, e: 0.82, CLa: 5.3, flaps: propFlaps([190, 160, 145]), vmo: 250, mmo: 0.6, ceiling: 28000, vr: 110,
    livery: ['#8a9580', '#6d7766', '#555e4f'], tsfc: 0, spool: 2.8, gearTrack: 4.4, noseGearZ: -10.4, mainGearZ: 0.5, gearH: 1.3, freighter: true })
];

// Freighter versions for Yük Modu (cheap → expensive)
const F = (baseId: string, id: string, name: string, price: number, extra: Partial<AircraftType> = {}): AircraftType => {
  const b = AIRCRAFT.find(a => a.id === baseId)!;
  return { ...b, id, name, short: b.short + 'F', seats: 0, freighter: true, price, baseOf: baseId, livery: ['#f2f3f4', '#e07a1f', '#2b2d42'], ...extra };
};
export const FREIGHTERS: AircraftType[] = [
  F('c208', 'c208f', 'Cessna 208 Cargomaster', 0, { payloadMax: 1600 }),
  F('atr72', 'atr72f', 'ATR 72F', 220000, { payloadMax: 8600, oew: 12900 }),
  F('dh8d', 'dh8df', 'Dash 8 Kargo', 420000, { payloadMax: 9100 }),
  F('b738', 'b738f', 'Boeing 737-800F', 900000, { payloadMax: 23900, oew: 40000 }),
  F('a321', 'a321f', 'Airbus A321F', 1500000, { payloadMax: 28000, oew: 46000 }),
  F('b752', 'b752f', 'Boeing 757-200F', 2300000, { payloadMax: 39000, oew: 52000 }),
  F('b763', 'b763f', 'Boeing 767-300F', 3600000, { payloadMax: 52000, oew: 86000 }),
  F('a333', 'a332f', 'Airbus A330-200F', 5200000, { payloadMax: 65000, oew: 109000, length: 58.8 }),
  F('b77w', 'b77f', 'Boeing 777F', 7800000, { payloadMax: 102000, oew: 144000, mtow: 347800, length: 63.7 }),
  F('b748', 'b748f', 'Boeing 747-8F', 11000000, { payloadMax: 134000, oew: 197000 }),
  { ...AIRCRAFT.find(a => a.id === 'an225')!, id: 'an225f', price: 18000000, baseOf: 'an225' }
];

export const ALL_TYPES = [...AIRCRAFT, ...FREIGHTERS];
export const typeById = (id: string) => ALL_TYPES.find(a => a.id === id) ?? AIRCRAFT.find(a => a.id === 'a320')!;
export const PHASE1_IDS = ['a320', 'b738', 'b77w'];
