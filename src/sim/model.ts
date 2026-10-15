// Procedural low-poly aircraft models (generic liveries). Nose points to -Z, up +Y, right +X.
import * as THREE from 'three';
import type { AircraftType } from './aircraftData';

export interface PlaneModel {
  root: THREE.Group;
  wingOuter: [THREE.Group, THREE.Group];   // L, R (breakable)
  wingInner: [THREE.Group, THREE.Group];
  flaps: THREE.Object3D[];                 // hinge groups (rotate x)
  spoilers: THREE.Object3D[];
  gear: { group: THREE.Group; kind: 'nose' | 'main'; side: number }[];
  props: THREE.Object3D[];
  propDiscs: THREE.Mesh[];
  engines: THREE.Group[];
  lights: { beacon: THREE.Mesh[]; strobe: THREE.Mesh[]; nav: THREE.Mesh[]; landing: THREE.Mesh[] };
  tail: THREE.Group;
  dims: { wingY: number; semi: number; breakAt: number; finTop: number; tailZ: number; noseZ: number; finH: number; rootChord: number };
  dispose(): void;
}

const lam = (c: THREE.ColorRepresentation, extra: THREE.MeshLambertMaterialParameters = {}) => new THREE.MeshLambertMaterial({ color: c, ...extra });

function fuselageGeo(t: AircraftType): THREE.BufferGeometry {
  const L = t.length, r = t.dia / 2;
  const zN = -L * 0.44, zT = L * 0.56;
  const seg = 18, rings = 34;
  const pos: number[] = [], idx: number[] = [];
  const hScale = t.deck === 'double' ? 1.18 : 1.04;
  for (let i = 0; i <= rings; i++) {
    const u = i / rings;
    const z = zN + (zT - zN) * u;
    let rr = r, yc = 0, hs = hScale;
    if (u < 0.13) { const k = u / 0.13; rr = r * Math.sqrt(1 - (1 - k) ** 2) * (0.25 + 0.75 * Math.min(1, k * 1.2)); yc = -r * 0.12 * (1 - k); }
    if (u > 0.72) { const k = (u - 0.72) / 0.28; rr = r * (1 - k * 0.86); yc = r * 0.55 * k * k; }
    if (t.deck === 'hump' && u < 0.42 && u > 0.04) hs *= 1 + 0.32 * Math.sin(Math.min(1, (u - 0.04) / 0.3) * Math.PI / 2) * (u > 0.3 ? (0.42 - u) / 0.12 : 1);
    for (let j = 0; j < seg; j++) {
      const a = j / seg * Math.PI * 2;
      const s = Math.sin(a), c = Math.cos(a);
      const top = s > 0 ? hs : 1;
      pos.push(c * rr, yc + s * rr * top, z);
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) {
    const a = i * seg + j, b = i * seg + (j + 1) % seg, c = a + seg, d = b + seg;
    idx.push(a, b, c, b, d, c);
  }
  const tipN = pos.length / 3; pos.push(0, -r * 0.12, zN - 0.02);
  const tipT = pos.length / 3; pos.push(0, r * 0.55, zT);
  for (let j = 0; j < seg; j++) { idx.push(tipN, (j + 1) % seg, j); idx.push(tipT, rings * seg + j, rings * seg + (j + 1) % seg); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** tapered, swept, thick plate from root (x0) to tip (x1) */
function wingPanel(x0: number, x1: number, zLE0: number, zLE1: number, c0: number, c1: number, t0: number, t1: number, y0: number, y1: number): THREE.BufferGeometry {
  // 6 points per section: LE, upper 30%, TE, lower
  const sec = (x: number, zl: number, c: number, th: number, y: number) => [
    [x, y, zl], [x, y + th * 0.6, zl + c * 0.28], [x, y + th * 0.15, zl + c], [x, y - th * 0.05, zl + c], [x, y - th * 0.4, zl + c * 0.3]
  ];
  const A = sec(x0, zLE0, c0, t0, y0), B = sec(x1, zLE1, c1, t1, y1);
  const pos: number[] = []; const idx: number[] = [];
  for (const p of [...A, ...B]) pos.push(...p);
  const n = 5;
  for (let i = 0; i < n; i++) { const a = i, b = (i + 1) % n; idx.push(a, b, n + a, b, n + b, n + a); }
  idx.push(0, 2, 1, 0, 3, 2, 0, 4, 3); idx.push(n, n + 1, n + 2, n, n + 2, n + 3, n, n + 3, n + 4);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed(); ng.computeVertexNormals();
  return ng;
}

function finGeo(h: number, cRoot: number, cTip: number, sweep: number, th: number): THREE.BufferGeometry {
  const off = Math.tan(sweep * Math.PI / 180) * h;
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(cRoot, 0); shape.lineTo(off + cTip, h); shape.lineTo(off, h); shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: th, bevelEnabled: false });
  g.translate(0, 0, -th / 2);
  g.rotateY(-Math.PI / 2); // x(along chord) → +z (backwards)
  return g;
}

export function buildModel(t: AircraftType): PlaneModel {
  const root = new THREE.Group();
  root.name = 'plane-' + t.id;
  const white = lam(t.livery[0]), tailC = lam(t.livery[1]), stripe = lam(t.livery[2]);
  const grey = lam('#9aa2ab'), dark = lam('#22262b'), metal = lam('#c8ccd2'), black = lam('#0d0f12'), tyre = lam('#1a1a1a');
  const glass = lam('#0b1622');
  const mats = [white, tailC, stripe, grey, dark, metal, black, tyre, glass];
  const L = t.length, r = t.dia / 2;
  const fus = new THREE.Mesh(fuselageGeo(t), white);
  root.add(fus);
  // cockpit windows + cabin window line + cheatline
  const ws = new THREE.Mesh(new THREE.BoxGeometry(r * 1.25, r * 0.22, r * 0.5), glass);
  ws.position.set(0, r * 0.42, -L * 0.44 + L * 0.075); ws.rotation.x = -0.45; root.add(ws);
  const cab0 = -L * 0.3, cab1 = L * 0.33;
  for (const s of [-1, 1]) {
    const wl = new THREE.Mesh(new THREE.BoxGeometry(0.05, r * 0.14, cab1 - cab0), glass);
    wl.position.set(s * r * 0.995, r * 0.22, (cab0 + cab1) / 2); root.add(wl);
    if (t.deck === 'double') { const w2 = wl.clone(); w2.position.y = r * 0.95; root.add(w2); }
    const st = new THREE.Mesh(new THREE.BoxGeometry(0.04, r * 0.12, L * 0.62), stripe);
    st.position.set(s * r * 1.0, -r * 0.05, L * 0.02); root.add(st);
  }

  // ---- wings
  const semi = t.b / 2;
  const lambda = t.kind === 'jet' ? 0.28 : 0.55;
  const cr = 2 * t.S / (t.b * (1 + lambda)) * 1.05, ct = cr * lambda;
  const sweepLE = (t.sweep + (t.kind === 'jet' ? 4 : 0)) * Math.PI / 180;
  const wingY = t.wing === 'low' ? -r * 0.62 : r * 0.82;
  const dihedral = t.wing === 'low' ? 0.085 : (t.id.startsWith('an225') ? -0.06 : 0.01);
  const zLEroot = -cr * 0.45;
  const breakAt = 0.56;
  const xr = r * 0.85;
  const xs = xr + (semi - xr) * breakAt;
  const zAt = (x: number) => zLEroot + (x - xr) * Math.tan(sweepLE);
  const cAt = (x: number) => cr + (ct - cr) * (x - xr) / (semi - xr);
  const yAt = (x: number) => wingY + (x - xr) * dihedral;
  const thAt = (x: number) => cAt(x) * (t.kind === 'jet' ? 0.11 : 0.15);
  const wingInner: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  const wingOuter: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  const flaps: THREE.Object3D[] = [], spoilers: THREE.Object3D[] = [];
  const lights = { beacon: [] as THREE.Mesh[], strobe: [] as THREE.Mesh[], nav: [] as THREE.Mesh[], landing: [] as THREE.Mesh[] };
  const glowMat = (c: string) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending });
  [-1, 1].forEach((s, si) => {
    const inner = wingInner[si], outer = wingOuter[si];
    const gi = wingPanel(xr * 0, xs, zAt(0) - 0.0, zAt(xs), cAt(0), cAt(xs), thAt(0), thAt(xs), wingY, yAt(xs));
    const go = wingPanel(xs, semi, zAt(xs), zAt(semi), cAt(xs), cAt(semi), thAt(xs), thAt(semi) * 0.8, yAt(xs), yAt(semi));
    if (s < 0) { gi.scale(-1, 1, 1); go.scale(-1, 1, 1); gi.computeVertexNormals(); go.computeVertexNormals(); }
    const mi = new THREE.Mesh(gi, metal), mo = new THREE.Mesh(go, metal);
    inner.add(mi); outer.add(mo);
    // flaps (trailing edge, inner + outer)
    const mkFlap = (xa: number, xb: number, parent: THREE.Group) => {
      const hinge = new THREE.Group();
      const zx = (zAt(xa) + cAt(xa) * 0.8 + zAt(xb) + cAt(xb) * 0.8) / 2;
      hinge.position.set(s * (xa + xb) / 2, (yAt(xa) + yAt(xb)) / 2, zx);
      const fl = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(xb - xa), thAt(xa) * 0.25, cAt((xa + xb) / 2) * 0.22), grey);
      fl.position.z = cAt((xa + xb) / 2) * 0.11;
      hinge.add(fl); parent.add(hinge); flaps.push(hinge);
    };
    mkFlap(xr + 0.3, xs, inner);
    mkFlap(xs, xs + (semi - xs) * 0.55, outer);
    // spoilers on top of inner wing
    const sp = new THREE.Group();
    const spx = (xr + xs) / 2;
    sp.position.set(s * spx, yAt(spx) + thAt(spx) * 0.45, zAt(spx) + cAt(spx) * 0.55);
    const spm = new THREE.Mesh(new THREE.BoxGeometry((xs - xr) * 0.8, 0.06, cAt(spx) * 0.16), grey);
    spm.position.z = -cAt(spx) * 0.08;
    sp.add(spm); inner.add(sp); spoilers.push(sp);
    // winglet
    if (t.kind === 'jet' && !['b77w', 'b748', 'b763', 'b752', 'b77f', 'b748f', 'b763f', 'b752f', 'an225', 'an225f', 'a333', 'a332f'].includes(t.id)) {
      const wl = new THREE.Mesh(finGeo(ct * 1.1, ct * 0.9, ct * 0.35, 35, 0.12), tailC);
      wl.position.set(s * semi, yAt(semi), zAt(semi));
      outer.add(wl);
    }
    // nav + strobe lights at the tip
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), glowMat(s < 0 ? '#ff2a2a' : '#2aff5a'));
    nav.position.set(s * (semi + 0.15), yAt(semi), zAt(semi) + ct * 0.2); outer.add(nav); lights.nav.push(nav);
    const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.35, 8, 6), glowMat('#ffffff'));
    strobe.position.copy(nav.position).add(new THREE.Vector3(0, 0, ct * 0.4)); outer.add(strobe); lights.strobe.push(strobe);
    // landing light at the root
    const ll = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), glowMat('#fff6e0'));
    ll.position.set(s * (xr + 1.2), wingY - 0.1, zAt(xr + 1.2) - 0.1); inner.add(ll); lights.landing.push(ll);
    root.add(inner, outer);
  });

  // ---- tail
  const tail = new THREE.Group();
  const finH = Math.max(1.5, (t.height - t.dia - t.gearH) * (t.tail === 'twin' ? 0.75 : 0.95));
  const finC = Math.max(1.2, L * 0.13);
  const zFin = L * 0.56 - finC * 1.05;
  const hsSpan = t.b * (t.kind === 'jet' ? 0.34 : 0.3);
  const hsC = finC * 0.7;
  const yTail = r * 0.5;
  const mkH = (y: number, z: number) => {
    for (const s of [-1, 1]) {
      const g = wingPanel(0, hsSpan / 2, z, z + Math.tan((t.sweep + 5) * Math.PI / 180) * hsSpan / 2, hsC, hsC * 0.4, hsC * 0.1, hsC * 0.05, y, y + hsSpan / 2 * 0.05);
      if (s < 0) { g.scale(-1, 1, 1); g.computeVertexNormals(); }
      tail.add(new THREE.Mesh(g, white));
    }
  };
  if (t.tail === 'twin') {
    mkH(yTail, zFin);
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(finGeo(finH, finC * 0.8, finC * 0.5, t.sweep + 5, 0.4), tailC);
      f.position.set(s * hsSpan / 2, yTail - finH * 0.3, zFin + hsC * 0.2); tail.add(f);
    }
  } else {
    const f = new THREE.Mesh(finGeo(finH, finC, finC * 0.45, t.sweep + 10, Math.max(0.25, r * 0.12)), tailC);
    f.position.set(0, yTail, zFin); tail.add(f);
    if (t.tail === 'T') mkH(yTail + finH * 0.96, zFin + Math.tan((t.sweep + 10) * Math.PI / 180) * finH + finC * 0.1);
    else mkH(yTail - r * 0.15, zFin + finC * 0.25);
  }
  const bcn = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), glowMat('#ff3030'));
  bcn.position.set(0, r * 1.05 * (t.deck === 'double' ? 1.18 : 1), -L * 0.05); root.add(bcn); lights.beacon.push(bcn);
  const bcn2 = bcn.clone(); bcn2.position.y = -r * 1.02; root.add(bcn2); lights.beacon.push(bcn2);
  const tl = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 6), glowMat('#ffffff'));
  tl.position.set(0, r * 0.55, L * 0.56 + 0.2); tail.add(tl); lights.nav.push(tl);
  root.add(tail);

  // ---- engines
  const engines: THREE.Group[] = [], props: THREE.Object3D[] = [], propDiscs: THREE.Mesh[] = [];
  const isProp = t.kind !== 'jet';
  const nd = isProp ? Math.max(0.8, Math.sqrt((t.power ?? 500)) * 0.028) : Math.max(1.1, Math.sqrt(t.thrust) * 0.0056);
  const nl = isProp ? nd * 3.2 : Math.max(2.4, nd * 2.1);
  for (const [x, y, z] of t.enginePos) {
    const e = new THREE.Group();
    e.position.set(x, t.engineMount === 'wing' ? Math.max(y, -(t.gearH - 0.67) + nd / 2) : y, z);
    if (t.engineMount !== 'nose') {
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(nd / 2, nd * 0.42, nl, 16, 1, false), white);
      nac.rotation.x = Math.PI / 2; e.add(nac);
      const intake = new THREE.Mesh(new THREE.CircleGeometry(nd * 0.46, 16), black);
      intake.position.z = -nl / 2 - 0.01; intake.rotation.y = Math.PI; e.add(intake);
      if (!isProp) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(nd * 0.25, nd * 0.6, 12), grey);
        cone.rotation.x = Math.PI / 2; cone.position.z = nl / 2 + nd * 0.25; e.add(cone);
        const ring = new THREE.Mesh(new THREE.TorusGeometry(nd * 0.48, nd * 0.05, 6, 20), metal);
        ring.position.z = -nl / 2; e.add(ring);
      }
      // pylon
      if (t.engineMount === 'wing') {
        const py = new THREE.Mesh(new THREE.BoxGeometry(0.35, Math.abs(wingY - y) + 0.3, nl * 0.8), white);
        py.position.set(0, (wingY - e.position.y) / 2 + (t.wing === 'low' ? nd * 0.2 : -nd * 0.2), nl * 0.1); py.scale.y = Math.max(0.3, Math.abs(wingY - e.position.y) + 0.3) / (Math.abs(wingY - y) + 0.3); e.add(py);
      } else {
        const py = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x) - r * 0.7, 0.35, nl * 0.5), white);
        py.position.set(-Math.sign(x) * (Math.abs(x) - r * 0.7) / 2, 0, 0); e.add(py);
      }
    }
    if (isProp) {
      const hub = new THREE.Group();
      hub.position.z = t.engineMount === 'nose' ? -0.3 : -nl / 2 - 0.15;
      const sp = new THREE.Mesh(new THREE.ConeGeometry(nd * 0.22, nd * 0.5, 12), metal);
      sp.rotation.x = -Math.PI / 2; hub.add(sp);
      const blades = new THREE.Group();
      const n = t.kind === 'piston' ? 2 : t.id.startsWith('dh8') ? 6 : 4;
      const pr = t.kind === 'piston' ? 0.95 : Math.max(1.3, nd * 1.6);
      for (let i = 0; i < n; i++) {
        const bl = new THREE.Mesh(new THREE.BoxGeometry(0.16, pr, 0.04), dark);
        bl.position.y = pr / 2; const pv = new THREE.Group(); pv.rotation.z = i / n * Math.PI * 2; pv.add(bl); blades.add(pv);
      }
      hub.add(blades); e.add(hub); props.push(blades);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(pr, 24), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.0, depthWrite: false, side: THREE.DoubleSide }));
      disc.position.z = hub.position.z - 0.05; e.add(disc); propDiscs.push(disc);
    }
    // attach to the wing section that carries it (so a broken wing takes its engine)
    if (t.engineMount === 'wing') {
      const si = x < 0 ? 0 : 1;
      if (Math.abs(x) > xs) wingOuter[si].add(e); else wingInner[si].add(e);
    } else root.add(e);
    engines.push(e);
  }

  // ---- landing gear
  const gear: PlaneModel['gear'] = [];
  const wheelR = Math.max(0.28, Math.min(0.68, t.gearH * 0.17));
  const mkLeg = (kind: 'nose' | 'main', x: number, z: number, wheels: number, side: number) => {
    const g = new THREE.Group();
    g.position.set(x, -r * 0.55, z);
    const legLen = t.gearH - r * 0.55 - wheelR;
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.1 + wheelR * 0.15, 0.1 + wheelR * 0.15, legLen, 8), metal);
    strut.position.y = -legLen / 2; g.add(strut);
    const rows = wheels >= 4 ? 2 + (wheels >= 6 ? 1 : 0) : 1;
    const perRow = wheels >= 4 ? 2 : wheels;
    for (let i = 0; i < rows; i++) for (let k = 0; k < perRow; k++) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(wheelR, wheelR, wheelR * 0.7, 14), tyre);
      w.rotation.z = Math.PI / 2;
      w.position.set((k - (perRow - 1) / 2) * wheelR * 1.0, -legLen, (i - (rows - 1) / 2) * wheelR * 2.3);
      g.add(w);
    }
    root.add(g);
    gear.push({ group: g, kind, side });
  };
  const heavy = t.mtow > 150000, vheavy = t.mtow > 330000;
  mkLeg('nose', 0, t.noseGearZ, t.mtow > 5000 ? 2 : 1, 0);
  mkLeg('main', -t.gearTrack / 2, t.mainGearZ, vheavy ? 6 : heavy ? 4 : t.mtow > 5000 ? 2 : 1, -1);
  mkLeg('main', t.gearTrack / 2, t.mainGearZ, vheavy ? 6 : heavy ? 4 : t.mtow > 5000 ? 2 : 1, 1);
  if (t.engines === 4 && t.kind === 'jet') { mkLeg('main', -t.gearTrack * 0.22, t.mainGearZ - 2.5, 4, -1); mkLeg('main', t.gearTrack * 0.22, t.mainGearZ - 2.5, 4, 1); }

  const dims = { wingY, semi, breakAt: xs, finTop: yTail + finH, tailZ: L * 0.56, noseZ: -L * 0.44, finH, rootChord: cr };
  return {
    root, wingOuter, wingInner, flaps, spoilers, gear, props, propDiscs, engines, lights, tail, dims,
    dispose() {
      root.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); });
      for (const m of mats) m.dispose();
    }
  };
}
