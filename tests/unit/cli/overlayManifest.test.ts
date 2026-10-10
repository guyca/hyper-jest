import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  disposeRunArtifacts, removeRunArtifacts, runArtifactsDir, setRunArtifactsBaseForTests, sweepStaleRunArtifacts, writeOverlayManifest,
} from '../../../src/overlayManifest';

describe('overlayManifest', () => {
  let base: string;
  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hj-overlay-')));
    setRunArtifactsBaseForTests(() => base);
  });
  afterEach(() => {
    disposeRunArtifacts();
    setRunArtifactsBaseForTests(undefined);
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('writes the manifest 0600 inside a private, unpredictable per-session directory', () => {
    const file = writeOverlayManifest('g12-ab/c_5', [
      { path: '/repo/a.ts', text: 'export {}', version: 3 },
      { path: '/repo/closed.ts', text: null, version: 1 },
    ])!;
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, files: { '/repo/a.ts': { text: 'export {}', version: 3 } } });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const session = path.dirname(path.dirname(file));
    expect(path.dirname(session)).toBe(base);
    expect(path.basename(session)).toMatch(new RegExp(`^hyperjest-${process.pid}-[A-Za-z0-9]+$`));
    expect(fs.statSync(session).mode & 0o777).toBe(0o700);
    expect(path.basename(path.dirname(file))).toBe('g12-ab_c_5');
    // Same session directory for every run of this process.
    expect(path.dirname(runArtifactsDir('other'))).toBe(session);
  });

  it('returns undefined when nothing is overlaid', () => {
    expect(writeOverlayManifest('r', [{ path: '/a', text: null, version: 1 }])).toBeUndefined();
    expect(writeOverlayManifest('r', [])).toBeUndefined();
  });

  it('removes one run, then the whole session on dispose', () => {
    const file = writeOverlayManifest('r1', [{ path: '/a', text: 'x', version: 1 }])!;
    const keep = writeOverlayManifest('r2', [{ path: '/a', text: 'y', version: 1 }])!;
    removeRunArtifacts('r1');
    expect(fs.existsSync(path.dirname(file))).toBe(false);
    expect(fs.existsSync(keep)).toBe(true);
    const session = path.dirname(path.dirname(keep));
    disposeRunArtifacts();
    expect(fs.existsSync(session)).toBe(false);
    removeRunArtifacts('r2'); // no session: no-op
    // A later run starts a fresh session directory.
    expect(fs.existsSync(runArtifactsDir('r3'))).toBe(true);
  });

  it('sweeps session directories of dead processes only', () => {
    const dead = path.join(base, 'hyperjest-999999-AbC123');
    const alive = path.join(base, `hyperjest-${process.ppid}-XyZ789`);
    const unrelated = path.join(base, 'hyperjest-cli-abc');
    for (const d of [dead, alive, unrelated]) fs.mkdirSync(path.join(d, 'run'), { recursive: true });
    sweepStaleRunArtifacts(base);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(alive)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
    // Creating the session directory sweeps too.
    fs.mkdirSync(dead);
    runArtifactsDir('r');
    expect(fs.existsSync(dead)).toBe(false);
  });
});
