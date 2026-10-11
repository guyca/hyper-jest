/* eslint-disable @typescript-eslint/no-explicit-any */
// ProjectRegistry with a minimal 'vscode' stand-in, a fake pool and a stubbed discovery.
jest.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners = new Set<(e: T) => void>();
    readonly event = (l: (e: T) => void) => { this.listeners.add(l); return { dispose: () => this.listeners.delete(l) }; };
    fire(e: T): void { for (const l of [...this.listeners]) l(e); }
    dispose(): void { this.listeners.clear(); }
  }
  const disposable = { dispose() { /* noop */ } };
  return {
    EventEmitter,
    RelativePattern: class { constructor(public base: string, public pattern: string) {} },
    workspace: {
      workspaceFolders: [],
      createFileSystemWatcher: () => ({ ...disposable, onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable }),
      onDidChangeWorkspaceFolders: () => disposable,
      findFiles: async () => [],
    },
  };
});
jest.mock('../../../src/discovery/hyperConfigLoader', () => ({ prepareHyperConfig: jest.fn() }));

import { prepareHyperConfig } from '../../../src/discovery/hyperConfigLoader';
import { ProjectRegistry, type RegistryEvent } from '../../../src/discovery/projectRegistry';
import { WorkerInitError, WorkerKilledError } from '../../../src/workerPool';
import { DEFAULT_SETTINGS, type HyperJestSettings } from '../../../src/core/settingsModel';
import { noopLogger } from '../../../src/core/logger';
import { PROTOCOL_VERSION, type ProjectSpec } from '../../../src/core/protocol';

const ENG = '/eng/packages/engine';

const spec = (id: string, over: Partial<ProjectSpec> = {}): ProjectSpec => ({
  id, displayName: `@example/engine · ${id}`, repoRoot: '/eng', packageDir: ENG, flavor: 'script-config', status: 'ok',
  configArg: `${ENG}/${id}`, nodePath: '/usr/bin/node', nodeArgs: [], env: {}, cliFilters: { testPathIgnorePatterns: [] },
  e2ePatterns: [], warnings: [], jestPkgDir: '/eng/node_modules/jest', jestVersion: '30.4.2', ...over,
});

const e2e = spec('e2e', { flavor: 'implicit', status: 'notJest', reason: 'e2e config (e2e) — excluded from unit runs', configArg: `${ENG}/e2e/jest.config.js`, jestVersion: undefined });
const integration = spec('jest.integration.config.js', { cliFilters: { testPathIgnorePatterns: [], testPathPatterns: ['./integration'] } });
const unit = spec('jest.unit.config.js');

function makeFakePool() {
  const pending: Array<{ projectId: string; resolve: (w: any) => void; reject: (e: Error) => void }> = [];
  const pool = {
    registerProject: jest.fn(),
    killProject: jest.fn(),
    release: jest.fn(),
    workersOf: jest.fn(() => []),
    acquire: jest.fn((projectId: string) => new Promise((resolve, reject) => { pending.push({ projectId, resolve, reject }); })),
  };
  return { pool, pending };
}

function storeMemento() {
  const values = new Map<string, unknown>();
  return { values, get: (k: string, d: unknown) => (values.has(k) ? values.get(k) : d), update: jest.fn(async (k: string, v: unknown) => { values.set(k, v); }) };
}

async function makeRegistry(specs: ProjectSpec[], settings: Partial<HyperJestSettings> = {}, opts: { autoBoot?: boolean; memento?: ReturnType<typeof storeMemento> } = {}) {
  const discovery = { beginRefresh: jest.fn(), discover: jest.fn().mockResolvedValue({ specs, skipped: [] }), dispose: jest.fn() };
  const { pool, pending } = makeFakePool();
  const memento = opts.memento ?? { get: (_k: string, d: unknown) => d, update: jest.fn(async () => undefined) };
  const registry = new ProjectRegistry(pool as any, () => ({ ...DEFAULT_SETTINGS, ...settings }), noopLogger, memento as any, discovery);
  // RunCoordinator.start() enables implicit boots; most tests model a started HyperJest.
  if (opts.autoBoot ?? true) registry.setAutoBoot(true);
  const events: RegistryEvent[] = [];
  registry.onDidChange(e => events.push(e));
  await registry.refresh();
  return { registry, pool, pending, events, memento, discovery };
}

const readyMsg = (rootDir: string, testMatch: string[]) => ({
  v: PROTOCOL_VERSION, type: 'ready' as const, jestVersion: '30.4.2', nodeVersion: 'v24.19.0', bootstrapMs: 1, warnings: [],
  seams: { envWrapper: true, probeTransformer: true, cachePrune: true },
  configs: [{ rootDir, roots: [rootDir], testMatch, testRegex: [], testPathIgnorePatterns: ['/node_modules/'], modulePathIgnorePatterns: [] }],
});

const flush = () => new Promise(r => setImmediate(r));

describe('ProjectRegistry discovery executor', () => {
  it('loads HyperJest configs between the preliminary and final discovery passes', async () => {
    const configFile = `${ENG}/hyperjest.config.js`;
    const preliminary = spec('native', { configFile });
    const final = spec('native', { configFile, env: { FROM_CONFIG: 'yes' } });
    (prepareHyperConfig as jest.Mock).mockResolvedValueOnce({ config: { env: { FROM_CONFIG: 'yes' } } });
    const discovery = {
      beginRefresh: jest.fn(),
      discover: jest.fn(async input => ({ specs: input.hyperConfigs ? [final] : [preliminary], skipped: [] })),
      dispose: jest.fn(),
    };
    const { pool } = makeFakePool();
    const registry = new ProjectRegistry(pool as any, () => DEFAULT_SETTINGS, noopLogger,
      { get: (_k: string, d: unknown) => d, update: async () => undefined } as any, discovery);
    try {
      expect((await registry.refresh()).specs).toEqual([final]);
      expect(discovery.beginRefresh).toHaveBeenCalledTimes(1);
      expect(discovery.discover).toHaveBeenCalledTimes(2);
      expect(discovery.discover.mock.calls[0][0].hyperConfigs).toBeUndefined();
      expect(prepareHyperConfig).toHaveBeenCalledWith(
        { file: configFile, wallaby: `${ENG}/wallaby.js` }, preliminary,
      );
      expect(discovery.discover.mock.calls[1][0].hyperConfigs).toEqual({
        [configFile]: { config: { env: { FROM_CONFIG: 'yes' } } },
      });
      expect(registry.get(final.id)?.spec).toEqual(final);
    } finally { registry.dispose(); }
    expect(discovery.dispose).toHaveBeenCalledTimes(1);
  });

  it('coalesces overlapping refreshes while running one discovery pass at a time', async () => {
    const resultA = { specs: [spec('a')], skipped: [] };
    const resultB = { specs: [spec('b')], skipped: [] };
    let resolveA!: (result: typeof resultA) => void;
    let resolveB!: (result: typeof resultB) => void;
    const discovery = {
      beginRefresh: jest.fn(),
      discover: jest.fn()
        .mockImplementationOnce(() => new Promise(resolve => { resolveA = resolve; }))
        .mockImplementationOnce(() => new Promise(resolve => { resolveB = resolve; })),
      dispose: jest.fn(),
    };
    const { pool } = makeFakePool();
    const registry = new ProjectRegistry(pool as any, () => DEFAULT_SETTINGS, noopLogger,
      { get: (_k: string, d: unknown) => d, update: async () => undefined } as any, discovery);
    try {
      const first = registry.refresh();
      expect(registry.refresh()).toBe(first);
      await flush();
      expect(discovery.discover).toHaveBeenCalledTimes(1);
      resolveA(resultA);
      await flush();
      expect(discovery.discover).toHaveBeenCalledTimes(2);
      resolveB(resultB);
      await expect(first).resolves.toEqual(resultB);
      expect(discovery.beginRefresh).toHaveBeenCalledTimes(2);
      expect(registry.all().map(entry => entry.spec.id)).toEqual(['b']);
    } finally { registry.dispose(); }
  });
});

describe('ProjectRegistry.projectFor among siblings of one package', () => {
  it('never lets a notJest (e2e) sibling with static matchers claim a unit test file', async () => {
    const { registry } = await makeRegistry([e2e, unit]);
    expect(registry.projectFor(`${ENG}/src/engine/foo.test.ts`)?.spec.id).toBe(unit.id);
    expect(registry.isTestFile(`${ENG}/src/engine/foo.test.ts`)).toBe(true);
  });

  it('applies the script positional path patterns (engine: jest -c jest.integration.config.js ./integration)', async () => {
    const { registry } = await makeRegistry([e2e, integration, unit]);
    expect(registry.projectFor(`${ENG}/src/engine/foo.test.ts`)?.spec.id).toBe(unit.id);
    expect(registry.projectFor(`${ENG}/integration/flow.test.ts`)?.spec.id).toBe(integration.id);
  });

  it('prefers a sibling whose matchers come from the worker over static defaults', async () => {
    const a = spec('a.config.js');
    const b = spec('b.config.js');
    const { registry, pending } = await makeRegistry([a, b]);
    const file = `${ENG}/src/x.test.ts`;
    expect(registry.projectFor(file)?.spec.id).toBe(a.id);
    // The tie on static matchers boots both siblings so their real configs decide.
    expect(pending.map(p => p.projectId).sort()).toEqual([a.id, b.id]);
    const ready = (rootDir: string, testMatch: string[]) => ({
      v: PROTOCOL_VERSION, type: 'ready' as const, jestVersion: '30.4.2', nodeVersion: 'v24.19.0', bootstrapMs: 1, warnings: [],
      seams: { envWrapper: true, probeTransformer: true, cachePrune: true },
      configs: [{ rootDir, roots: [rootDir], testMatch, testRegex: [], testPathIgnorePatterns: ['/node_modules/'], modulePathIgnorePatterns: [] }],
    });
    registry.noteReady(a.id, ready(ENG, ['**/integration/**/*.test.ts']) as any);
    registry.noteReady(b.id, ready(ENG, ['**/src/**/*.test.ts']) as any);
    expect(registry.projectFor(file)?.spec.id).toBe(b.id);
  });
});

describe('ProjectRegistry.ensureReady', () => {
  it('a kill during the boot resets readiness silently instead of reporting an init error', async () => {
    const { registry, pending, events } = await makeRegistry([unit]);
    const p = registry.ensureReady(unit.id);
    expect(registry.get(unit.id)?.readiness.kind).toBe('starting');
    pending[0].reject(new WorkerKilledError('project workers killed: stopped'));
    await expect(p).rejects.toBeInstanceOf(WorkerKilledError);
    await flush();
    expect(registry.get(unit.id)?.readiness.kind).toBe('cold');
    expect(events.some(e => e.type === 'initError')).toBe(false);
  });

  it('a real bootstrap failure is recorded and reported', async () => {
    const { registry, pending, events } = await makeRegistry([unit]);
    const p = registry.ensureReady(unit.id);
    pending[0].reject(new WorkerInitError({ v: PROTOCOL_VERSION, type: 'initError', kind: 'configLoad', message: 'boom' }));
    await expect(p).rejects.toBeInstanceOf(WorkerInitError);
    await flush();
    expect(registry.get(unit.id)?.readiness).toMatchObject({ kind: 'error', error: { kind: 'configLoad', message: 'boom' } });
    expect(events.filter(e => e.type === 'initError')).toHaveLength(1);
  });
});

describe('ProjectRegistry.noteReady', () => {
  it('ignores a ready it already applied (the runner reports it on every dispatch)', async () => {
    const { registry, memento, events } = await makeRegistry([unit]);
    const ready = readyMsg(ENG, ['**/*.unit.ts']) as any;
    registry.noteReady(unit.id, ready);
    const matchers = registry.get(unit.id)?.matchers;
    const writes = memento.update.mock.calls.length;
    registry.noteReady(unit.id, ready);
    registry.noteReady(unit.id, ready);
    expect(memento.update.mock.calls.length).toBe(writes);
    expect(registry.get(unit.id)?.matchers).toBe(matchers);
    expect(events.filter(e => e.type === 'ready')).toHaveLength(1);
    // A new worker's ready (another object) is applied.
    registry.noteReady(unit.id, readyMsg(ENG, ['**/*.spec.ts']) as any);
    expect(registry.get(unit.id)?.matchers).not.toBe(matchers);
  });
});

describe('ProjectRegistry.invalidate', () => {
  afterEach(() => jest.useRealTimers());

  it('recycles the project through the invalidated event, coalesced like a watched toolchain change', async () => {
    const { registry, pool, events } = await makeRegistry([unit]);
    jest.useFakeTimers();
    registry.noteReady(unit.id, readyMsg(ENG, ['**/*.test.ts']) as any);
    registry.invalidate(unit.id, [`${ENG}/jest.setup.ts`]);
    registry.invalidate(unit.id, [`${ENG}/babel.config.js`]);
    expect(pool.killProject).not.toHaveBeenCalled();
    jest.advanceTimersByTime(600);
    expect(pool.killProject).toHaveBeenCalledTimes(1);
    expect(registry.get(unit.id)?.readiness.kind).toBe('cold');
    // Learned configs give way to Jest's defaults until a worker reports again.
    expect(registry.get(unit.id)?.configsSource).toBe('static');
    expect(registry.get(unit.id)?.configs).toBeUndefined();
    const inv = events.filter(e => e.type === 'invalidated');
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ projectId: unit.id, paths: [`${ENG}/jest.setup.ts`, `${ENG}/babel.config.js`] });
    registry.invalidate('unknown', ['/x']);
    jest.advanceTimersByTime(600);
    expect(pool.killProject).toHaveBeenCalledTimes(1);
  });
});

describe('ProjectRegistry implicit boots while stopped', () => {
  const a = spec('a.config.js');
  const b = spec('b.config.js');
  const file = `${ENG}/src/x.test.ts`;

  it('spawns nothing for sibling ties or ensureReady before the runner starts', async () => {
    const { registry, pool } = await makeRegistry([a, b], {}, { autoBoot: false });
    expect(registry.projectFor(file)?.spec.id).toBe(a.id);
    await expect(registry.ensureReady(a.id)).rejects.toThrow('HyperJest is stopped');
    expect(pool.acquire).not.toHaveBeenCalled();
    expect(registry.get(a.id)?.readiness.kind).toBe('cold');
  });

  it('a Stop during the first boot is not reversed by the next lookup', async () => {
    const { registry, pool, pending } = await makeRegistry([a, b]);
    registry.projectFor(file);
    expect(pool.acquire).toHaveBeenCalledTimes(2);
    // RunCoordinator.stop(): gate first, then kill the projects (rejects the boots).
    registry.setAutoBoot(false);
    for (const p of pending) p.reject(new WorkerKilledError('project workers killed: stopped'));
    await flush();
    expect(registry.get(a.id)?.readiness.kind).toBe('cold');
    registry.projectFor(file);
    registry.isTestFile(file);
    expect(pool.acquire).toHaveBeenCalledTimes(2);
    // Start again: lookups may boot.
    registry.setAutoBoot(true);
    registry.projectFor(file);
    expect(pool.acquire).toHaveBeenCalledTimes(4);
  });
});

describe('ProjectRegistry config cache', () => {
  it('clearConfigCache resets learned configs and matchers to the static defaults', async () => {
    const { registry } = await makeRegistry([unit]);
    const f = `${ENG}/src/a.unit.ts`;
    registry.noteReady(unit.id, readyMsg(ENG, ['**/*.unit.ts']) as any);
    expect(registry.isTestFile(f)).toBe(true);
    registry.clearConfigCache();
    const e = registry.get(unit.id)!;
    expect(e.configsSource).toBe('static');
    expect(e.configs).toBeUndefined();
    expect(e.readiness.kind).toBe('cold');
    expect(registry.isTestFile(f)).toBe(false);
    expect(registry.isTestFile(`${ENG}/src/a.test.ts`)).toBe(true);
  });

  it('an edited config file invalidates the cached matchers (content signature in the fingerprint)', async () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const os = jest.requireActual('os') as typeof import('os');
    const path = jest.requireActual('path') as typeof import('path');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hj-reg-')));
    try {
      const cfg = path.join(dir, 'jest.config.js');
      fs.writeFileSync(cfg, 'module.exports = {};\n');
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      const s = spec('jest.config.js', { packageDir: dir, configArg: cfg });
      const memento = storeMemento();
      const first = await makeRegistry([s], {}, { memento });
      first.registry.noteReady(s.id, readyMsg(dir, ['**/*.unit.ts']) as any);
      await flush();
      expect((await makeRegistry([s], {}, { memento })).registry.get(s.id)?.configsSource).toBe('cache');
      fs.writeFileSync(cfg, 'module.exports = { testMatch: ["**/*.spec.ts"] };\n');
      expect((await makeRegistry([s], {}, { memento })).registry.get(s.id)?.configsSource).toBe('static');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an edited implicit jest.config.* (no configArg) invalidates the cached matchers too', async () => {
    const fs = jest.requireActual('fs') as typeof import('fs');
    const os = jest.requireActual('os') as typeof import('os');
    const path = jest.requireActual('path') as typeof import('path');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hj-reg-')));
    try {
      const cfg = path.join(dir, 'jest.config.js');
      fs.writeFileSync(cfg, 'module.exports = {};\n');
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      const s = spec('implicit', { packageDir: dir, flavor: 'implicit', configArg: undefined });
      const memento = storeMemento();
      const first = await makeRegistry([s], {}, { memento });
      first.registry.noteReady(s.id, readyMsg(dir, ['**/*.unit.ts']) as any);
      await flush();
      expect((await makeRegistry([s], {}, { memento })).registry.get(s.id)?.configsSource).toBe('cache');
      fs.writeFileSync(cfg, 'module.exports = { testMatch: ["**/*.spec.ts"] };\n');
      expect((await makeRegistry([s], {}, { memento })).registry.get(s.id)?.configsSource).toBe('static');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
