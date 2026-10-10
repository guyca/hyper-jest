import * as realFs from 'fs';
import {
  OverlayStore, install, makeOverlayStats, overlayContent, readEncodingOf, syntheticMtimeMs, SYNTHETIC_MTIME_BASE_MS,
} from '../../../src/worker/overlayFs';

type AnyFn = (...a: any[]) => any;

/** A fake `fs` module so the patch never touches the fs Jest itself is using. */
function fakeFs() {
  const disk = new Map<string, string>([['/proj/a.js', 'disk-a'], ['/proj/b.js', 'disk-b']]);
  const realStat = realFs.statSync(__filename);
  const calls: string[] = [];
  const target: Record<string, AnyFn | Record<string, AnyFn>> = {
    readFileSync: (p: string, o?: unknown) => { calls.push(`readFileSync ${p}`); const t = disk.get(p); if (t === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return readEncodingOf(o) ? t : Buffer.from(t); },
    readFile: (p: string, o: unknown, cb?: AnyFn) => { const callback = typeof o === 'function' ? o : cb!; calls.push(`readFile ${p}`); process.nextTick(() => callback(null, disk.get(p))); },
    statSync: (p: string) => { calls.push(`statSync ${p}`); return realStat; },
    lstatSync: (p: string) => { calls.push(`lstatSync ${p}`); return realStat; },
    writeFileSync: (p: string, d: string) => { calls.push(`writeFileSync ${p}`); disk.set(p, d); },
    writeFile: (p: string, d: string, o: unknown, cb?: AnyFn) => { const callback = typeof o === 'function' ? o : cb!; disk.set(p, d); process.nextTick(() => callback(null)); },
    promises: {
      readFile: async (p: string, o?: unknown) => { calls.push(`p.readFile ${p}`); const t = disk.get(p)!; return readEncodingOf(o) ? t : Buffer.from(t); },
      stat: async () => realStat,
      lstat: async () => realStat,
      writeFile: async (p: string, d: string) => { disk.set(p, d); },
    },
  };
  return { target: target as unknown as typeof realFs, disk, calls, realStat };
}

describe('overlayFs', () => {
  it('synthetic mtimes are far in the future and monotonic in the version', () => {
    expect(syntheticMtimeMs(3)).toBe(SYNTHETIC_MTIME_BASE_MS + 3);
    expect(syntheticMtimeMs(4)).toBeGreaterThan(syntheticMtimeMs(3));
    expect(syntheticMtimeMs(NaN)).toBe(SYNTHETIC_MTIME_BASE_MS);
    expect(syntheticMtimeMs(0)).toBeGreaterThan(Date.now());
  });

  it('makeOverlayStats keeps the Stats prototype and overrides mtime', () => {
    const real = realFs.statSync(__filename);
    const s = makeOverlayStats(real, 123456);
    expect(s.isFile()).toBe(true);
    expect(s.mtimeMs).toBe(123456);
    expect(s.mtime.getTime()).toBe(123456);
    expect(real.mtimeMs).not.toBe(123456);
  });

  it('encodes overlay content for utf8, Buffer and other encodings', () => {
    const e = { text: 'héllo', version: 1 };
    expect(overlayContent(e, 'utf8')).toBe('héllo');
    expect(overlayContent(e, { encoding: 'utf-8' })).toBe('héllo');
    expect(Buffer.isBuffer(overlayContent(e, undefined))).toBe(true);
    expect(overlayContent(e, 'base64')).toBe(Buffer.from('héllo').toString('base64'));
    expect(readEncodingOf(null)).toBeNull();
    expect(readEncodingOf({ flag: 'r' })).toBeNull();
  });

  it('store tracks generations of changes', () => {
    const store = new OverlayStore();
    store.set('/proj/x.js', 'a', 1);
    store.set('/proj/./y.js', 'b', 2);
    expect(store.has('/proj/y.js')).toBe(true);
    const first = store.changedSince(0);
    expect(first.paths.sort()).toEqual(['/proj/x.js', '/proj/y.js']);
    expect(store.changedSince(first.generation).paths).toEqual([]);
    expect(store.delete('/proj/x.js')).toBe(true);
    expect(store.delete('/proj/x.js')).toBe(false);
    expect(store.changedSince(first.generation).paths).toEqual(['/proj/x.js']);
    expect(store.paths()).toEqual(['/proj/y.js']);
  });

  it('serves overlay content, synthetic stats and blocks writes on a patched fs module', async () => {
    const { target, disk, calls, realStat } = fakeFs();
    const store = install(target);
    expect(install(target)).toBe(store);
    const blocked: string[] = [];
    store.onWriteBlocked(p => blocked.push(p));

    // Nothing overlaid: pass-through to the real implementation.
    expect(target.readFileSync('/proj/a.js', 'utf8')).toBe('disk-a');
    expect(target.statSync('/proj/a.js')).toBe(realStat);

    store.set('/proj/a.js', 'overlay-a', 7);
    expect(target.readFileSync('/proj/a.js', 'utf8')).toBe('overlay-a');
    expect(target.readFileSync('/proj/a.js', { encoding: 'utf8' })).toBe('overlay-a');
    expect((target.readFileSync('/proj/a.js') as Buffer).toString()).toBe('overlay-a');
    expect(target.readFileSync('/proj/b.js', 'utf8')).toBe('disk-b');
    expect(target.readFileSync(new URL('file:///proj/a.js'), 'utf8')).toBe('overlay-a');
    expect(calls.filter(c => c === 'readFileSync /proj/a.js')).toHaveLength(1);

    await expect(new Promise((res, rej) => target.readFile('/proj/a.js', 'utf8', (e, d) => (e ? rej(e) : res(d))))).resolves.toBe('overlay-a');
    await expect(new Promise((res, rej) => target.readFile('/proj/a.js', (e, d) => (e ? rej(e) : res(d.toString()))))).resolves.toBe('overlay-a');
    await expect(target.promises.readFile('/proj/a.js', 'utf8')).resolves.toBe('overlay-a');
    await expect(target.promises.readFile('/proj/b.js', 'utf8')).resolves.toBe('disk-b');

    const st = target.statSync('/proj/a.js');
    expect(st.mtimeMs).toBe(syntheticMtimeMs(7));
    expect(st.isFile()).toBe(true);
    expect(target.lstatSync('/proj/a.js').mtime.getTime()).toBe(syntheticMtimeMs(7));
    expect(target.statSync('/proj/a.js', { bigint: true } as never)).toBe(realStat);
    expect((await target.promises.stat('/proj/a.js')).mtimeMs).toBe(syntheticMtimeMs(7));
    store.set('/proj/a.js', 'overlay-a2', 8);
    expect(target.statSync('/proj/a.js').mtimeMs).toBe(syntheticMtimeMs(8));

    expect(() => target.writeFileSync('/proj/a.js', 'x')).toThrow(/unsaved changes/);
    await expect(new Promise<void>((res, rej) => target.writeFile('/proj/a.js', 'x', e => (e ? rej(e) : res())))).rejects.toMatchObject({ code: 'EHYPERJEST_OVERLAY' });
    await expect(target.promises.writeFile('/proj/a.js', 'x')).rejects.toMatchObject({ code: 'EHYPERJEST_OVERLAY' });
    expect(disk.get('/proj/a.js')).toBe('disk-a');
    expect(blocked).toEqual(['/proj/a.js', '/proj/a.js', '/proj/a.js']);
    target.writeFileSync('/proj/b.js', 'new-b');
    expect(disk.get('/proj/b.js')).toBe('new-b');

    store.delete('/proj/a.js');
    expect(target.readFileSync('/proj/a.js', 'utf8')).toBe('disk-a');
    expect(target.statSync('/proj/a.js')).toBe(realStat);
  });
});
