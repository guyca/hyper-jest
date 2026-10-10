import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.HYPERJEST_OVERLAY_NO_AUTO = '1';

interface OverlayEntry { text: string; version: number }
interface OverlayManifest { version: number; files: Record<string, OverlayEntry> }
interface OverlayHandle { files: Map<string, OverlayEntry>; version: number; restore(): void }
interface PreloadModule {
  OVERLAY_ENV: string;
  BLOCKED_CODE: string;
  parseManifest(json: string): OverlayManifest;
  loadManifest(p: string, read?: (p: string, enc: BufferEncoding) => string): OverlayManifest;
  installOverlay(fsMod: typeof fs, manifest: OverlayManifest, options?: { emit?: (e: Record<string, unknown>) => void; manifestPath?: string }): OverlayHandle;
  createFd3Emitter(writeSync?: typeof fs.writeSync): (e: Record<string, unknown>) => void;
  autoInstall(env?: NodeJS.ProcessEnv, emit?: (e: Record<string, unknown>) => void): OverlayHandle | undefined;
  patchStats<T>(stats: T, entry: OverlayEntry): T;
  keyOf(p: unknown): string | undefined;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const preload = require('../../../src/worker/overlayPreload') as PreloadModule;

const A = path.resolve('/proj/src/a.js');
const B = path.resolve('/proj/src/b.js');

/** Minimal fake fs: two files on "disk" with fixed stats; records writes. */
function fakeFs() {
  const disk: Record<string, string> = { [A]: 'disk a', [B]: 'disk b' };
  const writes: Array<[string, string]> = [];
  const stats = (p: string) => {
    if (!(p in disk)) { const e = Object.assign(new Error(`ENOENT ${p}`), { code: 'ENOENT' }); throw e; }
    return { mtimeMs: 1000, mtime: new Date(1000), ctimeMs: 1000, ctime: new Date(1000), size: disk[p].length, isFile: () => true, isDirectory: () => false };
  };
  const enc = (text: string, o: unknown) => (typeof o === 'string' || (o && typeof o === 'object' && (o as { encoding?: string }).encoding) ? text : Buffer.from(text));
  const f = {
    readFileSync: jest.fn((p: string, o?: unknown) => { if (!(p in disk)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return enc(disk[p], o); }),
    readFile: jest.fn((p: string, o: unknown, cb?: (e: Error | null, d?: unknown) => void) => { const callback = (typeof o === 'function' ? o : cb) as (e: Error | null, d?: unknown) => void; process.nextTick(() => callback(null, enc(disk[p], typeof o === 'function' ? undefined : o))); }),
    statSync: jest.fn((p: string) => stats(p)),
    lstatSync: jest.fn((p: string) => stats(p)),
    stat: jest.fn((p: string, o: unknown, cb?: (e: Error | null, s?: unknown) => void) => { const callback = (typeof o === 'function' ? o : cb) as (e: Error | null, s?: unknown) => void; process.nextTick(() => { try { callback(null, stats(p)); } catch (e) { callback(e as Error); } }); }),
    lstat: jest.fn((p: string, cb: (e: Error | null, s?: unknown) => void) => process.nextTick(() => cb(null, stats(p)))),
    writeFileSync: jest.fn((p: string, d: string) => { writes.push([p, d]); }),
    appendFileSync: jest.fn((p: string, d: string) => { writes.push([p, d]); }),
    writeFile: jest.fn((p: string, d: string, o: unknown, cb?: (e: Error | null) => void) => { writes.push([p, d]); const callback = (typeof o === 'function' ? o : cb) as (e: Error | null) => void; process.nextTick(() => callback(null)); }),
    appendFile: jest.fn((p: string, d: string, cb: (e: Error | null) => void) => { writes.push([p, d]); process.nextTick(() => cb(null)); }),
    realpathSync: Object.assign((p: string) => p, { native: (p: string) => (p === A ? '/real/a.js' : p) }),
    writeSync: jest.fn(() => 0),
    promises: {
      readFile: jest.fn(async (p: string, o?: unknown) => enc(disk[p], o)),
      stat: jest.fn(async (p: string) => stats(p)),
      lstat: jest.fn(async (p: string) => stats(p)),
      writeFile: jest.fn(async (p: string, d: string) => { writes.push([p, d]); }),
      appendFile: jest.fn(async (p: string, d: string) => { writes.push([p, d]); }),
    },
  };
  return { f: f as unknown as typeof fs, disk, writes };
}

const manifest: OverlayManifest = { version: 7, files: { [A]: { text: 'overlay é', version: 3 } } };

describe('overlayPreload', () => {
  it('parses and validates manifests', () => {
    expect(preload.parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(preload.parseManifest(JSON.stringify({ files: { [A]: { text: 'x' } } }))).toEqual({ version: 0, files: { [A]: { text: 'x', version: 0 } } });
    expect(() => preload.parseManifest('[]')).toThrow(/not an object/);
    expect(() => preload.parseManifest(JSON.stringify({ files: { 'rel/a.js': { text: 'x' } } }))).toThrow(/not absolute/);
    expect(() => preload.parseManifest(JSON.stringify({ files: { [A]: { version: 1 } } }))).toThrow(/no text/);
    expect(preload.loadManifest('/m.json', () => JSON.stringify(manifest))).toEqual(manifest);
  });

  it('normalises path arguments', () => {
    expect(preload.keyOf(A)).toBe(A);
    expect(preload.keyOf(Buffer.from(A))).toBe(A);
    expect(preload.keyOf(new URL(`file://${A}`))).toBe(A);
    expect(preload.keyOf(7)).toBeUndefined();
    expect(preload.keyOf('')).toBeUndefined();
  });

  it('serves overlay text through sync, callback and promise reads; other files untouched', async () => {
    const { f } = fakeFs();
    const emitted: Array<Record<string, unknown>> = [];
    const handle = preload.installOverlay(f, manifest, { emit: e => emitted.push(e), manifestPath: '/m.json' });
    expect(emitted).toEqual([{ type: 'overlayApplied', manifest: '/m.json', version: 7, files: 1 }]);
    expect(handle.files.has(A)).toBe(true);
    expect(handle.files.has('/real/a.js')).toBe(true); // realpath alias

    expect(f.readFileSync(A, 'utf8')).toBe('overlay é');
    expect(f.readFileSync(A, { encoding: 'utf8' })).toBe('overlay é');
    expect(f.readFileSync(A)).toEqual(Buffer.from('overlay é', 'utf8'));
    expect(f.readFileSync('/real/a.js', 'utf8')).toBe('overlay é');
    expect(f.readFileSync(B, 'utf8')).toBe('disk b');
    await expect(new Promise(res => f.readFile(A, 'utf8', (_e, d) => res(d)))).resolves.toBe('overlay é');
    await expect(new Promise(res => f.readFile(A, (_e, d) => res(d)))).resolves.toEqual(Buffer.from('overlay é'));
    await expect(new Promise(res => f.readFile(B, 'utf8', (_e, d) => res(d)))).resolves.toBe('disk b');
    await expect(f.promises.readFile(A, 'utf8')).resolves.toBe('overlay é');
    await expect(f.promises.readFile(B, 'utf8')).resolves.toBe('disk b');

    handle.restore();
    expect(f.readFileSync(A, 'utf8')).toBe('disk a');
  });

  it('reports a synthetic mtime and the overlay size for overlaid paths only', async () => {
    const { f } = fakeFs();
    preload.installOverlay(f, manifest, { emit: () => {} });
    const sa = f.statSync(A);
    expect(sa.mtimeMs).toBe(1000 + 3 + 1);
    expect(sa.mtime.getTime()).toBe(1004);
    expect(sa.ctimeMs).toBe(1004);
    expect(sa.size).toBe(Buffer.byteLength('overlay é', 'utf8'));
    expect(sa.isFile()).toBe(true);
    expect(f.lstatSync(A).mtimeMs).toBe(1004);
    expect(f.statSync(B).mtimeMs).toBe(1000);
    await expect(new Promise(res => f.stat(A, (_e, s) => res(s!.mtimeMs)))).resolves.toBe(1004);
    await expect(new Promise(res => f.stat(B, {}, (_e, s) => res(s!.mtimeMs)))).resolves.toBe(1000);
    await expect(new Promise(res => f.lstat(A, (_e, s) => res(s!.mtimeMs)))).resolves.toBe(1004);
    await expect(f.promises.stat(A).then(s => s.mtimeMs)).resolves.toBe(1004);
    await expect(f.promises.lstat(B).then(s => s.mtimeMs)).resolves.toBe(1000);
    await expect(new Promise((res, rej) => f.stat('/nope', e => (e ? rej(e) : res(0))))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves bigint stats alone and tolerates undefined (throwIfNoEntry:false)', () => {
    const big = { mtimeMs: BigInt(5) };
    expect(preload.patchStats(big, { text: 'x', version: 1 })).toBe(big);
    expect(big.mtimeMs).toBe(BigInt(5));
    expect(preload.patchStats(undefined, { text: 'x', version: 1 })).toBeUndefined();
  });

  it('blocks writes to overlaid paths and emits overlayWriteBlocked', async () => {
    const { f, writes } = fakeFs();
    const emitted: Array<Record<string, unknown>> = [];
    preload.installOverlay(f, manifest, { emit: e => emitted.push(e) });
    expect(() => f.writeFileSync(A, 'new')).toThrow(expect.objectContaining({ code: preload.BLOCKED_CODE }));
    expect(() => f.appendFileSync('/real/a.js', 'new')).toThrow(/unsaved changes/);
    await expect(new Promise((res, rej) => f.writeFile(A, 'x', e => (e ? rej(e) : res(0))))).rejects.toMatchObject({ code: 'EHJOVERLAY' });
    await expect(new Promise((res, rej) => f.appendFile(A, 'x', e => (e ? rej(e) : res(0))))).rejects.toMatchObject({ code: 'EHJOVERLAY' });
    await expect(f.promises.writeFile(A, 'x')).rejects.toMatchObject({ code: 'EHJOVERLAY' });
    await expect(f.promises.appendFile(A, 'x')).rejects.toMatchObject({ code: 'EHJOVERLAY' });
    expect(writes).toEqual([]);
    expect(emitted.filter(e => e.type === 'overlayWriteBlocked')).toHaveLength(6);
    expect(emitted[1]).toEqual({ type: 'overlayWriteBlocked', path: A });

    f.writeFileSync(B, 'ok');
    await new Promise<void>((res, rej) => f.writeFile(B, 'ok2', e => (e ? rej(e) : res())));
    await f.promises.writeFile(B, 'ok3');
    expect(writes.map(w => w[1])).toEqual(['ok', 'ok2', 'ok3']);
  });

  it('fd-3 emitter swallows write errors and stops after a fatal one', () => {
    const calls: string[] = [];
    let fail: string | undefined = 'EAGAIN';
    const emit = preload.createFd3Emitter(((_fd: number, s: string) => { if (fail) { const e = Object.assign(new Error(fail), { code: fail }); throw e; } calls.push(s); return s.length; }) as unknown as typeof fs.writeSync);
    emit({ type: 'a' }); // EAGAIN: retryable, nothing recorded
    fail = undefined;
    emit({ type: 'b' });
    expect(calls).toEqual(['{"v":1,"type":"b"}\n']);
    fail = 'EBADF';
    emit({ type: 'c' });
    fail = undefined;
    emit({ type: 'd' }); // dead after EBADF
    expect(calls).toHaveLength(1);
  });

  it('autoInstall: no env -> nothing; unreadable manifest -> overlayError, no crash', () => {
    expect(preload.autoInstall({}, () => {})).toBeUndefined();
    const emitted: Array<Record<string, unknown>> = [];
    expect(preload.autoInstall({ HYPERJEST_OVERLAY: path.join(os.tmpdir(), 'hyperjest-missing-manifest.json') }, e => emitted.push(e))).toBeUndefined();
    expect(emitted).toEqual([{ type: 'overlayError', message: expect.stringContaining('hyperjest-missing-manifest.json') }]);
    expect(preload.OVERLAY_ENV).toBe('HYPERJEST_OVERLAY');
  });
});
