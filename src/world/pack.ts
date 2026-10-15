// Offline world pack: downloaded once (Wi-Fi) into IndexedDB as SHA-256 verified chunks.
// Tiles are read back as Blob slices of the stored chunk blobs (file-backed in WebKit, low memory).

export interface ChunkInfo { file: string; size: number; sha256: string }
export interface PackManifest {
  region: string; version: number; built: string; totalSize: number;
  bbox: { south: number; north: number; west: number; east: number };
  airports: string[]; index: ChunkInfo; chunks: ChunkInfo[]; levels: Record<string, number>; attribution: string[];
  imagery: { format: string }; elevation: { format: string };
}
export interface PackProgress { phase: 'idle' | 'manifest' | 'download' | 'verify' | 'done' | 'paused' | 'error'; done: number; total: number; chunk: number; chunks: number; message?: string; speed?: number }

const DB = 'acilinis-pack';
const base = import.meta.env.BASE_URL;

function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('chunks'); r.result.createObjectStore('meta'); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function req<T>(r: IDBRequest<T>): Promise<T> { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
async function put(store: string, key: string, val: unknown) {
  const db = await idb();
  await new Promise<void>((res, rej) => {
    const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
}
async function get<T>(store: string, key: string): Promise<T | undefined> {
  const db = await idb();
  return req(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}
async function keys(store: string): Promise<string[]> {
  const db = await idb();
  return (await req(db.transaction(store).objectStore(store).getAllKeys())) as string[];
}
async function sha256(buf: ArrayBuffer) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(h, b => b.toString(16).padStart(2, '0')).join('');
}

type IndexEntry = [number, number, number];

class Pack {
  manifest: PackManifest | null = null;
  index: Record<string, IndexEntry> | null = null;
  ready = false;
  private blobs = new Map<number, Blob>();
  private abort: AbortController | null = null;
  listeners = new Set<(p: PackProgress) => void>();
  progress: PackProgress = { phase: 'idle', done: 0, total: 0, chunk: 0, chunks: 0 };

  /** Load installed pack (works fully offline). */
  async init() {
    try {
      const m = await get<PackManifest>('meta', 'manifest');
      const complete = await get<boolean>('meta', 'complete');
      if (!m) return false;
      this.manifest = m;
      if (complete) {
        const idxBlob = await get<Blob>('meta', 'index');
        if (idxBlob) { this.index = JSON.parse(await idxBlob.text()); this.ready = true; }
      }
    } catch (e) { console.warn('pack init', e); }
    return this.ready;
  }

  has(kind: 'i' | 'e', z: number, x: number, y: number) { return !!this.index?.[`${kind}/${z}/${x}/${y}`]; }

  async tile(kind: 'i' | 'e', z: number, x: number, y: number): Promise<Blob | null> {
    const e = this.index?.[`${kind}/${z}/${x}/${y}`];
    if (!e) return null;
    let b = this.blobs.get(e[0]);
    if (!b) {
      const c = this.manifest!.chunks[e[0]];
      b = await get<Blob>('chunks', c.file);
      if (!b) return null;
      this.blobs.set(e[0], b);
    }
    return b.slice(e[1], e[1] + e[2], kind === 'i' ? 'image/webp' : 'image/png');
  }

  private emit(p: Partial<PackProgress>) {
    this.progress = { ...this.progress, ...p };
    for (const l of this.listeners) l(this.progress);
  }

  async remoteManifest(): Promise<PackManifest> {
    const r = await fetch(base + 'pack/manifest.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('Paket bilgisi alınamadı (' + r.status + ')');
    return r.json();
  }

  /** Download (or resume) the pack. Already verified chunks are skipped. */
  async download() {
    if (this.abort) return;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    try {
      try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
      this.emit({ phase: 'manifest', message: 'Paket bilgisi alınıyor…' });
      const m = await this.remoteManifest();
      const old = await get<PackManifest>('meta', 'manifest');
      if (old && (old.version !== m.version || old.built !== m.built)) { await this.clear(); }
      await put('meta', 'manifest', m);
      await put('meta', 'complete', false);
      this.manifest = m;
      const have = new Set(await keys('chunks'));
      const verified = (await get<Record<string, string>>('meta', 'verified')) ?? {};
      let done = 0;
      for (const c of m.chunks) if (have.has(c.file) && verified[c.file] === c.sha256) done += c.size;
      const total = m.totalSize;
      this.emit({ phase: 'download', done, total, chunks: m.chunks.length, chunk: 0, message: '' });
      const t0 = performance.now(); let got = 0;

      const fetchVerified = async (info: ChunkInfo, onBytes: (n: number) => void) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await fetch(base + 'pack/' + info.file, { signal, cache: 'no-store' });
          if (!r.ok || !r.body) throw new Error(info.file + ' indirilemedi (' + r.status + ')');
          const reader = r.body.getReader();
          const parts: Uint8Array[] = []; let n = 0;
          for (;;) {
            const { value, done: d } = await reader.read();
            if (d) break;
            parts.push(value); n += value.length; onBytes(value.length);
          }
          const buf = new Uint8Array(n); let o = 0;
          for (const p of parts) { buf.set(p, o); o += p.length; }
          if (n === info.size && (await sha256(buf.buffer)) === info.sha256) return buf;
          onBytes(-n);
          this.emit({ message: `${info.file} doğrulanamadı, tekrar deneniyor…` });
        }
        throw new Error(info.file + ' bütünlük kontrolünden geçmedi');
      };

      // index first
      const idxBuf = await fetchVerified(m.index, () => {});
      await put('meta', 'index', new Blob([idxBuf]));
      for (let i = 0; i < m.chunks.length; i++) {
        const c = m.chunks[i];
        if (have.has(c.file) && verified[c.file] === c.sha256) continue;
        this.emit({ chunk: i + 1 });
        const buf = await fetchVerified(c, n => {
          done += n; got += n;
          const dt = (performance.now() - t0) / 1000;
          this.emit({ done, speed: dt > 1 ? got / dt : 0 });
        });
        await put('chunks', c.file, new Blob([buf], { type: 'application/octet-stream' }));
        verified[c.file] = c.sha256;
        await put('meta', 'verified', verified);
      }
      await put('meta', 'complete', true);
      this.blobs.clear();
      await this.init();
      this.emit({ phase: 'done', done: total, message: 'Hazır ✓' });
    } catch (e: any) {
      if (signal.aborted) this.emit({ phase: 'paused', message: 'Duraklatıldı' });
      else this.emit({ phase: 'error', message: e?.message ?? String(e) });
    } finally {
      this.abort = null;
    }
  }

  pause() { this.abort?.abort(); }
  get downloading() { return !!this.abort; }

  /** Re-hash every stored chunk. */
  async verify(): Promise<{ ok: boolean; bad: string[] }> {
    const m = (await get<PackManifest>('meta', 'manifest')) ?? null;
    if (!m) return { ok: false, bad: ['manifest'] };
    const bad: string[] = [];
    let done = 0;
    this.emit({ phase: 'verify', done: 0, total: m.totalSize, message: 'Bütünlük kontrolü…' });
    const verified = (await get<Record<string, string>>('meta', 'verified')) ?? {};
    const idx = await get<Blob>('meta', 'index');
    if (!idx || (await sha256(await idx.arrayBuffer())) !== m.index.sha256) bad.push('index');
    for (const c of m.chunks) {
      const b = await get<Blob>('chunks', c.file);
      const ok = !!b && b.size === c.size && (await sha256(await b.arrayBuffer())) === c.sha256;
      if (!ok) { bad.push(c.file); delete verified[c.file]; }
      done += c.size;
      this.emit({ done });
    }
    await put('meta', 'verified', verified);
    if (bad.length) { await put('meta', 'complete', false); this.ready = false; }
    this.emit({ phase: bad.length ? 'error' : 'done', message: bad.length ? `${bad.length} parça bozuk — yeniden indirin` : 'Hazır ✓ (bütünlük doğrulandı)' });
    return { ok: !bad.length, bad };
  }

  async storedBytes() {
    const m = await get<PackManifest>('meta', 'manifest');
    if (!m) return 0;
    const have = new Set(await keys('chunks'));
    return m.chunks.filter(c => have.has(c.file)).reduce((s, c) => s + c.size, 0);
  }

  async clear() {
    this.blobs.clear(); this.index = null; this.ready = false; this.manifest = null;
    const db = await idb();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(['chunks', 'meta'], 'readwrite');
      tx.objectStore('chunks').clear(); tx.objectStore('meta').clear();
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
    });
  }
}

export const pack = new Pack();
