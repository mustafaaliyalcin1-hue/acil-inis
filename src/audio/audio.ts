// WebAudio-generated sounds (no samples): engines tied to N1, wind, tyre screech, warnings & voice callouts.
import { store } from '../core/store';

export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private engines: { noise: GainNode; whine: OscillatorNode; whineG: GainNode; filt: BiquadFilterNode; prop?: OscillatorNode; propG?: GainNode }[] = [];
  private wind!: { g: GainNode; f: BiquadFilterNode };
  private rumble!: { g: GainNode; f: BiquadFilterNode };
  private shaker!: { g: GainNode; o: OscillatorNode };
  private noiseBuf!: AudioBuffer;
  private loops = new Map<string, number>();
  private lastSay = new Map<string, number>();
  private voice: SpeechSynthesisVoice | null = null;
  private speaking = false;

  init() {
    if (this.ctx) { this.ctx.resume(); return; }
    const C = (window.AudioContext || (window as any).webkitAudioContext);
    if (!C) return;
    this.ctx = new C();
    const ctx = this.ctx;
    this.master = ctx.createGain(); this.master.gain.value = store.settings.volume; this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0); let b = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2.5; }
    const noiseNode = () => { const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; s.start(); return s; };
    const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.frequency.value = 600; wf.Q.value = 0.5;
    const wg = ctx.createGain(); wg.gain.value = 0; noiseNode().connect(wf); wf.connect(wg); wg.connect(this.master);
    this.wind = { g: wg, f: wf };
    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 160;
    const rg = ctx.createGain(); rg.gain.value = 0; noiseNode().connect(rf); rf.connect(rg); rg.connect(this.master);
    this.rumble = { g: rg, f: rf };
    const so = ctx.createOscillator(); so.type = 'square'; so.frequency.value = 18;
    const sg = ctx.createGain(); sg.gain.value = 0; const sf = ctx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 220;
    so.connect(sf); sf.connect(sg); sg.connect(this.master); so.start();
    this.shaker = { g: sg, o: so };
    const pick = () => { const vs = speechSynthesis.getVoices(); this.voice = vs.find(v => /en[-_]US/i.test(v.lang) && /Fred|Alex|Daniel|Aaron|Samantha|Google US/i.test(v.name)) ?? vs.find(v => /^en/i.test(v.lang)) ?? null; };
    try { pick(); speechSynthesis.onvoiceschanged = pick; } catch { /* no speech */ }
  }

  setupEngines(n: number, kind: 'jet' | 'turboprop' | 'piston') {
    if (!this.ctx) return;
    for (const e of this.engines) { e.noise.disconnect(); e.whine.stop(); e.prop?.stop(); }
    this.engines = [];
    const ctx = this.ctx;
    const count = Math.min(n, 2);
    for (let i = 0; i < count; i++) {
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true; src.start(ctx.currentTime + i * 0.37);
      const filt = ctx.createBiquadFilter(); filt.type = 'bandpass'; filt.Q.value = 0.8;
      const noise = ctx.createGain(); noise.gain.value = 0;
      src.connect(filt); filt.connect(noise);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) { pan.pan.value = count > 1 ? (i ? 0.4 : -0.4) : 0; noise.connect(pan); pan.connect(this.master); } else noise.connect(this.master);
      const whine = ctx.createOscillator(); whine.type = kind === 'jet' ? 'sawtooth' : 'triangle';
      const wf = ctx.createBiquadFilter(); wf.type = 'bandpass'; wf.Q.value = 6;
      const whineG = ctx.createGain(); whineG.gain.value = 0;
      whine.connect(wf); wf.connect(whineG); whineG.connect(pan ?? this.master); whine.start();
      const e: any = { noise, whine, whineG, filt };
      if (kind !== 'jet') {
        const prop = ctx.createOscillator(); prop.type = 'sawtooth';
        const pg = ctx.createGain(); pg.gain.value = 0; const pf = ctx.createBiquadFilter(); pf.type = 'lowpass'; pf.frequency.value = 400;
        prop.connect(pf); pf.connect(pg); pg.connect(pan ?? this.master); prop.start();
        e.prop = prop; e.propG = pg;
      }
      this.engines.push(e);
    }
  }

  /** per-frame continuous sounds */
  update(p: { n1: number[]; running: boolean[]; ias: number; onGround: boolean; gs: number; shaker: boolean; cockpit: boolean; kind: string; paused: boolean }) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, k = 0.08;
    this.master.gain.setTargetAtTime(p.paused ? 0 : store.settings.volume, t, 0.1);
    const inside = p.cockpit ? 0.55 : 1;
    this.engines.forEach((e, i) => {
      const n1 = p.n1[i] ?? 0, on = p.running[i] ?? false;
      const lvl = Math.pow(Math.max(0, n1), 1.6) * (on ? 1 : 0.25);
      e.noise.gain.setTargetAtTime(lvl * 0.5 * inside, t, k);
      e.filt.frequency.setTargetAtTime(250 + n1 * 1800, t, k);
      e.whine.frequency.setTargetAtTime(p.kind === 'jet' ? 900 + n1 * 3200 : 120 + n1 * 600, t, k);
      e.whineG.gain.setTargetAtTime(lvl * (p.kind === 'jet' ? 0.08 : 0.05) * inside, t, k);
      if (e.prop && e.propG) { e.prop.frequency.setTargetAtTime(30 + n1 * 70, t, k); e.propG.gain.setTargetAtTime(lvl * 0.25 * inside, t, k); }
    });
    const ws = Math.min(1, p.ias / 320);
    this.wind.g.gain.setTargetAtTime(ws * ws * 0.35, t, 0.2);
    this.wind.f.frequency.setTargetAtTime(300 + ws * 1500, t, 0.2);
    this.rumble.g.gain.setTargetAtTime(p.onGround ? Math.min(0.6, p.gs / 120) : 0, t, 0.08);
    this.shaker.g.gain.setTargetAtTime(p.shaker ? 0.35 : 0, t, 0.03);
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.25, at = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + at;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.01); g.gain.setTargetAtTime(0, t + dur * 0.7, dur * 0.15);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.3);
  }
  screech(intensity: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2200; f.Q.value = 3;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(Math.min(0.7, 0.2 + intensity), t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + 0.6);
  }
  thud(v: number) { this.tone(55, 0.35, 'sine', Math.min(0.9, 0.2 + v * 0.1)); this.tone(90, 0.2, 'triangle', Math.min(0.5, v * 0.05)); }
  crunch() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
    const g = this.ctx.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    s.connect(f); f.connect(g); g.connect(this.master); s.start(t); s.stop(t + 1.5);
  }
  masterCaution() { this.tone(1250, 0.18, 'square', 0.12); this.tone(1250, 0.18, 'square', 0.12, 0.28); }
  masterWarning() { this.tone(880, 0.2, 'square', 0.15); this.tone(660, 0.25, 'square', 0.15, 0.22); }
  fireBell() { for (let i = 0; i < 6; i++) { this.tone(1700, 0.08, 'square', 0.12, i * 0.12); this.tone(2300, 0.06, 'sine', 0.08, i * 0.12 + 0.01); } }
  clacker() { for (let i = 0; i < 8; i++) this.tone(400, 0.04, 'square', 0.18, i * 0.09); }
  chime() { this.tone(660, 0.6, 'sine', 0.18); this.tone(880, 0.8, 'sine', 0.14, 0.18); }

  /** repeating warning while condition holds; call every frame with active flag */
  loop(id: string, active: boolean, interval: number, fn: () => void) {
    const now = performance.now();
    const last = this.loops.get(id);
    if (!active) { this.loops.delete(id); return; }
    if (last === undefined || now - last > interval) { this.loops.set(id, now); fn(); }
  }

  say(text: string, minGapMs = 2500, rate = 1.1) {
    if (!store.settings.voice) return;
    const now = performance.now();
    if ((this.lastSay.get(text) ?? -1e9) > now - minGapMs) return;
    this.lastSay.set(text, now);
    try {
      if (this.speaking && /^\d+$/.test(text)) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      if (this.voice) u.voice = this.voice;
      u.lang = 'en-US'; u.rate = rate; u.pitch = 0.8; u.volume = Math.min(1, store.settings.volume * 1.2);
      u.onstart = () => { this.speaking = true; }; u.onend = () => { this.speaking = false; };
      speechSynthesis.speak(u);
    } catch { /* ignore */ }
  }
  stopAll() { try { speechSynthesis.cancel(); } catch { /* */ } this.loops.clear(); }
}

export const audio = new Audio();
