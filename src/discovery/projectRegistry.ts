import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { buildChildEnv } from '../core/childEnv';
import { HYPER_CONFIG_NAME, scopeMatches } from '../core/hyperConfig';
import { prepareHyperConfig } from './hyperConfigLoader';
import { summarizeConfig } from '../worker/configSummary';
import type { Logger } from '../core/logger';
import type { HyperJestSettings } from '../core/settingsModel';
import type { DiscoveryResult, SkippedPackage } from '../core/projectSpec';
import type { DiscoveryExecutor } from './discoveryProtocol';
import { applyCliFilters, createMatcher, JEST_CONFIG_EXT_ORDER, jestDefaultsFor, type TestFileMatcher } from '../core/testFileMatcher';
import { jestMajor } from '../core/jestResolver';
import { isUnder, normalizePath } from '../core/paths';
import type { InitErrorMsg, ProjectSpec, ReadyMsg, ResolvedConfigSummary, WorkerFlags } from '../core/protocol';
import { WorkerInitError, WorkerKilledError, type WorkerPool } from '../workerPool';
import { scanPackageJsons } from './packageScanner';
import { ConfigCache } from './configCache';

export type ProjectReadiness =
  | { kind: 'cold' }
  | { kind: 'starting'; promise: Promise<ReadyMsg> }
  | { kind: 'ready'; ready: ReadyMsg; at: number }
  | { kind: 'error'; error: InitErrorMsg | { kind: 'unknown'; message: string }; at: number };

export interface ProjectEntry {
  spec: ProjectSpec;
  readiness: ProjectReadiness;
  /** Resolved configs from the worker or the cache (undefined until known). */
  configs?: ResolvedConfigSummary[];
  configsSource?: 'worker' | 'cache' | 'static';
  revision?: number;
  matchers: TestFileMatcher[];
}

export type RegistryEvent =
  | { type: 'refreshed'; result: DiscoveryResult }
  | { type: 'ready'; projectId: string; ready: ReadyMsg }
  | { type: 'initError'; projectId: string; error: ProjectReadiness & { kind: 'error' } }
  | { type: 'invalidated'; projectId: string; reason: string; paths: string[] };

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;

/**
 * Jest's matcher for one config with the package script's CLI filters applied: `--testPathIgnorePatterns`
 * replaces the config value, positional / `--testPathPattern(s)` must also accept the path (Jest applies
 * them after `isTestFilePath`).
 */
function filteredMatcher(cfg: Parameters<typeof applyCliFilters>[0], spec: ProjectSpec, major: number): TestFileMatcher {
  const { config, pathPattern } = applyCliFilters(cfg, spec.cliFilters);
  const m = createMatcher(config, { jestMajor: major });
  const allowed = (p: string) => (!pathPattern || pathPattern(p)) && (!spec.scope || scopeMatches(p, spec.scope.baseDir, spec.scope.tests));
  return {
    config: m.config,
    isTestFile: p => m.isTestFile(p) && allowed(p),
    explain: p => { const x = m.explain(p); return { ...x, matched: x.matched && allowed(p) }; },
  };
}

/** Toolchain files watched on disk: an edit recycles the workers of the projects they configure. */
const TOOLCHAIN_FILE_GLOB = '**/{package.json,jest.config.*,jest.*.config.*,hyperjest.config.js,hyperjest.*.config.js,wallaby.js,wallaby.*.js,babel.config.*,.babelrc,.babelrc.*,tsconfig.json,tsconfig.*.json,.swcrc,yarn.lock,package-lock.json,pnpm-lock.yaml}';
/** Basenames matched by TOOLCHAIN_FILE_GLOB (other disk watchers leave these to the registry). */
export const TOOLCHAIN_FILE_NAME = /^(?:package\.json|jest(?:\..+)?\.config\..+|hyperjest(?:\..+)?\.config\.js|wallaby(?:\..+)?\.js|babel\.config\..+|\.babelrc(?:\..+)?|tsconfig(?:\..+)?\.json|\.swcrc|yarn\.lock|package-lock\.json|pnpm-lock\.yaml)$/;

/**
 * Knows every Jest project in the workspace: discovers package.json files, classifies them (pure
 * core/projectSpec), maps files to projects, boots a project's first worker on demand to learn its
 * resolved Jest configs, and watches toolchain files to invalidate projects.
 */
export class ProjectRegistry implements vscode.Disposable {
  private readonly entries = new Map<string, ProjectEntry>();
  private skipped: SkippedPackage[] = [];
  private readonly emitter = new vscode.EventEmitter<RegistryEvent>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly nodeVersionCache = new Map<string, string | null>();
  private refreshing: Promise<DiscoveryResult> | undefined;
  private refreshAgain = false;
  private invalidateTimer: NodeJS.Timeout | undefined;
  private pendingInvalidations = new Map<string, Set<string>>();
  private readonly configCache: ConfigCache;
  /**
   * Whether implicit lookups (sibling ties in projectFor, opened files, Explorer expansion) may boot a
   * worker. Driven by RunCoordinator.start/stop so nothing is spawned while HyperJest is stopped;
   * explicit commands (Show Resolved Config, Doctor) acquire workers from the pool directly.
   */
  private autoBoot = false;

  constructor(
    private readonly pool: WorkerPool,
    private readonly settings: () => HyperJestSettings,
    private readonly log: Logger,
    memento: vscode.Memento,
    private readonly discovery: DiscoveryExecutor,
  ) {
    this.configCache = new ConfigCache(memento);
    const watcher = vscode.workspace.createFileSystemWatcher(TOOLCHAIN_FILE_GLOB);
    const onToolchain = (uri: vscode.Uri) => this.onToolchainFileChanged(uri.fsPath);
    this.disposables.push(watcher, watcher.onDidChange(onToolchain), watcher.onDidCreate(onToolchain), watcher.onDidDelete(onToolchain));
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()));
  }

  // ------------------------------------------------------------------ discovery

  /** Re-scans the workspace. Safe to call concurrently (coalesced). */
  refresh(): Promise<DiscoveryResult> {
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
      let result: DiscoveryResult;
      do { this.refreshAgain = false; result = await this.doRefresh(); } while (this.refreshAgain);
      return result;
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<DiscoveryResult> {
    this.discovery.beginRefresh();
    const s = this.settings();
    const started = Date.now();
    const packageJsonPaths = await scanPackageJsons(s.discovery.exclude, this.log);
    // The complete discovery passes, including synchronous file I/O, run in a dedicated thread.
    const input = {
      packageJsonPaths,
      settings: s,
      homeDir: os.homedir(),
      platform: process.platform,
      env: { ...process.env },
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
      nodeVersionCache: this.nodeVersionCache,
      electronExecPath: process.execPath,
      hostNodeVersion: process.versions.node,
    };
    const preliminary = await this.discovery.discover(input);
    const hyperConfigs: NonNullable<import('../core/projectSpec').DiscoveryInput['hyperConfigs']> = {};
    // Bounded, sequential imports: generated files exist before selection and any Smart Start runs.
    for (const spec of preliminary.specs) if (spec.configFile) {
      const wallaby = spec.configFile.replace(/hyperjest(?:\.(.+))?\.config\.js$/, (_match, name: string | undefined) => `wallaby${name ? `.${name}` : ''}.js`);
      hyperConfigs[spec.configFile] = await prepareHyperConfig({ file: spec.configFile, wallaby }, spec);
      if (hyperConfigs[spec.configFile].error) this.log.warn(hyperConfigs[spec.configFile].error!);
    }
    const result = Object.keys(hyperConfigs).length ? await this.discovery.discover({ ...input, hyperConfigs }) : preliminary;
    const seen = new Set<string>();
    for (const spec of result.specs) {
      seen.add(spec.id);
      const existing = this.entries.get(spec.id);
      if (existing) {
        const changed = JSON.stringify(existing.spec) !== JSON.stringify(spec);
        if (changed) {
          existing.spec = spec;
          this.pool.killProject(spec.id, 'spec changed');
          existing.readiness = { kind: 'cold' };
          existing.revision = (existing.revision ?? 0) + 1;
          existing.matchers = this.staticMatchers(spec);
          existing.configs = undefined;
          existing.configsSource = 'static';
        }
      } else {
        const entry: ProjectEntry = { spec, readiness: { kind: 'cold' }, matchers: this.staticMatchers(spec), configsSource: 'static' };
        const cached = this.configCache.get(spec.id, c => this.fingerprint(spec, c.configs));
        if (cached) {
          entry.configs = cached.configs;
          entry.configsSource = 'cache';
          entry.matchers = this.matchersFromConfigs(spec, cached.configs);
        }
        this.entries.set(spec.id, entry);
      }
      if (spec.status === 'ok' && spec.selected !== false) this.pool.registerProject(spec, this.flags());
    }
    for (const id of [...this.entries.keys()]) {
      if (!seen.has(id)) {
        this.pool.killProject(id, 'project removed');
        this.entries.delete(id);
      }
    }
    this.skipped = result.skipped;
    const ok = result.specs.filter(sp => sp.status === 'ok' && sp.selected !== false).length;
    this.log.info(`discovery: ${result.specs.length} project(s), ${ok} runnable, ${result.skipped.length} skipped package(s) in ${Date.now() - started} ms`);
    this.emitter.fire({ type: 'refreshed', result });
    return result;
  }

  /** Enables or disables implicit worker boots (see `autoBoot`). */
  setAutoBoot(enabled: boolean): void { this.autoBoot = enabled; }

  /** Current worker flags derived from settings (re-registered on settings change). */
  flags(): WorkerFlags {
    const s = this.settings();
    return {
      coverage: s.coverage.enabled,
      perTestCoverage: s.coverage.enabled && s.coverage.perTest,
      liveComments: s.liveComments.enabled,
      instrumentTestFiles: s.coverage.instrumentTestFiles,
      globalSetup: s.globalSetup,
      tsJestDiagnostics: s.tsJest.diagnostics,
      trace: s.trace,
    };
  }

  /** Called when settings that affect workers change. */
  onSettingsChanged(): void {
    for (const e of this.entries.values()) if (e.spec.status === 'ok' && e.spec.selected !== false) this.pool.registerProject(e.spec, this.flags());
  }

  // ------------------------------------------------------------------ queries

  all(): ProjectEntry[] { return [...this.entries.values()]; }
  get(projectId: string): ProjectEntry | undefined { return this.entries.get(projectId); }
  skippedPackages(): SkippedPackage[] { return this.skipped; }

  /**
   * Deepest project whose package dir contains the file. Among siblings (same package dir: several
   * script configs, a nested e2e config), the one whose matcher accepts it, ranked runnable before
   * notJest/unavailable and worker/cache-derived matchers before static Jest defaults.
   */
  projectFor(fsPath: string): ProjectEntry | undefined {
    const p = normalizePath(fsPath);
    let best: ProjectEntry[] = [];
    let bestLen = -1;
    for (const e of this.entries.values()) {
      if (e.spec.status === 'disabled' || e.spec.selected === false) continue;
      const dir = normalizePath(e.spec.packageDir);
      if (!isUnder(p, dir) && p !== dir) continue;
      if (dir.length > bestLen) { bestLen = dir.length; best = [e]; }
      else if (dir.length === bestLen) best.push(e);
    }
    if (!best.length) return undefined;
    if (best.length === 1) return best[0];
    const rank = (e: ProjectEntry) => (e.spec.status === 'ok' ? 0 : 2) + (e.configsSource === 'static' ? 1 : 0);
    const accepting = best.filter(e => e.matchers.some(m => m.isTestFile(p)));
    if (accepting.length) {
      const top = Math.min(...accepting.map(rank));
      const tied = accepting.filter(e => rank(e) === top);
      // Runnable siblings that only know Jest's default testMatch cannot tell their files apart: boot
      // them so their real configs decide the next lookup.
      if (top === 1 && tied.length > 1 && this.autoBoot && this.settings().engine !== 'cli') for (const e of tied) if (e.readiness.kind === 'cold') void this.ensureReady(e.spec.id).catch(() => undefined);
      return tied[0];
    }
    return best.find(e => e.spec.status === 'ok') ?? best[0];
  }

  /** Every selected config at the deepest owning package boundary. */
  projectsFor(fsPath: string): ProjectEntry[] {
    const eligible = this.all().filter(e => isUnder(fsPath, e.spec.packageDir));
    const depth = Math.max(-1, ...eligible.map(e => normalizePath(e.spec.packageDir).length));
    return eligible.filter(e => normalizePath(e.spec.packageDir).length === depth && e.spec.selected !== false && e.spec.status === 'ok');
  }

  acceptsTest(projectId: string, file: string): boolean {
    const entry = this.get(projectId);
    return !!entry && entry.spec.selected !== false && entry.spec.status === 'ok'
      && entry.matchers.some(m => m.isTestFile(file)) && this.projectsFor(file).some(e => e.spec.id === projectId);
  }

  monitorsSource(projectId: string, file: string): boolean {
    const spec = this.get(projectId)?.spec;
    return !!spec && (!spec.scope || scopeMatches(file, spec.scope.baseDir, spec.scope.files));
  }

  private resolvingMatchers = new Map<string, Promise<void>>();
  resolveMatchers(projectId: string): Promise<void> {
    if (this.refreshing) return this.refreshing.then(() => this.resolveMatchers(projectId));
    const e = this.get(projectId);
    if (!e || e.spec.selected === false || e.spec.status !== 'ok' || e.configsSource !== 'static') return Promise.resolve();
    const pending = this.resolvingMatchers.get(projectId);
    if (pending) return pending.then(() => this.resolveMatchers(projectId));
    const originalSpec = e.spec;
    const revision = e.revision;
    const promise = (async () => {
      if (this.settings().engine !== 'cli') {
        try { await this.ensureReady(projectId); return; }
        catch (error) { if (this.settings().engine === 'warm') throw error; }
      }
      if (this.get(projectId) !== e || e.spec !== originalSpec || e.revision !== revision) return;
      const spec = e.spec;
      if (!spec.nodePath || !spec.jestBinPath) throw new Error(`No Jest runtime for ${spec.displayName}`);
      const args = [...spec.nodeArgs, spec.jestBinPath, ...(spec.configArg ? ['--config', spec.configArg] : []), '--showConfig'];
      const text = await new Promise<string>((resolve, reject) => execFile(spec.nodePath!, args, {
        cwd: spec.packageDir, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
        env: buildChildEnv({ base: process.env, nodePath: spec.nodePath!, projectEnv: spec.env, electronAsNode: spec.env.ELECTRON_RUN_AS_NODE === '1' }),
      }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      const configs = (JSON.parse(text).configs as Record<string, unknown>[]).map(summarizeConfig);
      if (this.get(projectId) !== e || e.spec !== spec || e.revision !== revision) return;
      e.configs = configs;
      e.configsSource = 'worker';
      e.matchers = this.matchersFromConfigs(spec, configs);
      await this.configCache.set(spec.id, this.fingerprint(spec, configs), configs, spec.jestVersion!);
    })().finally(() => this.resolvingMatchers.delete(projectId));
    this.resolvingMatchers.set(projectId, promise);
    return promise.then(() => {
      if (this.get(projectId) !== e || e.spec !== originalSpec || e.revision !== revision) return this.resolveMatchers(projectId);
    });
  }

  projectIdFor(fsPath: string): string | undefined { return this.projectFor(fsPath)?.spec.id; }

  isTestFile(fsPath: string): boolean {
    if (!SOURCE_EXT.test(fsPath)) return false;
    return this.projectsFor(fsPath).some(e => this.acceptsTest(e.spec.id, fsPath));
  }

  /** True for a source file inside a runnable project (not a test file). */
  isSourceFile(fsPath: string): boolean {
    if (!SOURCE_EXT.test(fsPath) || fsPath.includes(`${path.sep}node_modules${path.sep}`)) return false;
    return this.projectsFor(fsPath).some(e => this.monitorsSource(e.spec.id, fsPath) && !this.acceptsTest(e.spec.id, fsPath));
  }

  /** Enumerates the project's test files via the matcher (bounded glob under the package dir). */
  async testFilesOf(projectId: string, token?: vscode.CancellationToken): Promise<string[]> {
    const e = this.entries.get(projectId);
    if (!e || e.spec.status !== 'ok' || e.spec.selected === false) return [];
    await this.resolveMatchers(projectId);
    if (this.get(projectId) !== e || this.get(projectId)?.spec.selected === false) return [];
    const s = this.settings();
    const pattern = new vscode.RelativePattern(e.spec.packageDir, '**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}');
    const exclude = `{${[...s.discovery.exclude, '**/node_modules/**'].join(',')}}`;
    const uris = await vscode.workspace.findFiles(pattern, exclude, 50000, token);
    // Files that belong to a nested package (deeper packageDir) are not ours.
    return uris.map(u => u.fsPath).filter(f => this.projectsFor(f).some(p => p.spec.id === projectId) && e.matchers.some(m => m.isTestFile(f))).sort();
  }

  /** Files the resolved config declares as toolchain (setup files, config, transformer paths). */
  toolchainFiles(projectId: string): Set<string> {
    const e = this.entries.get(projectId);
    const out = new Set<string>();
    if (!e) return out;
    if (e.spec.configFile) out.add(e.spec.configFile);
    if (e.spec.configArg) out.add(e.spec.configArg);
    for (const c of e.configs ?? []) {
      if (c.globalSetup) out.add(c.globalSetup);
      if (c.testEnvironment && path.isAbsolute(c.testEnvironment)) out.add(c.testEnvironment);
    }
    return out;
  }

  // ------------------------------------------------------------------ readiness

  /**
   * Boots the project's first worker (or reuses a live one) to learn the resolved configs.
   * Resolves with the worker's `ready`; rejects with WorkerInitError when Jest cannot be loaded, and
   * without spawning anything while implicit boots are disabled (HyperJest stopped).
   */
  ensureReady(projectId: string): Promise<ReadyMsg> {
    const e = this.entries.get(projectId);
    if (!e) return Promise.reject(new Error(`unknown project ${projectId}`));
    if (e.spec.status !== 'ok' || e.spec.selected === false) return Promise.reject(new Error(e.spec.reason ?? `project is ${e.spec.status}`));
    if (e.readiness.kind === 'ready') return Promise.resolve(e.readiness.ready);
    if (e.readiness.kind === 'starting') return e.readiness.promise;
    const live = this.pool.workersOf(projectId).find(w => w.info.ready);
    if (live?.info.ready) {
      this.applyReady(e, live.info.ready);
      return Promise.resolve(live.info.ready);
    }
    if (!this.autoBoot) return Promise.reject(new Error('HyperJest is stopped'));
    const revision = e.revision;
    const originalSpec = e.spec;
    const promise = (async () => {
      const worker = await this.pool.acquire(projectId, { priority: 1, spare: false });
      try {
        const ready = worker.info.ready ?? (await worker.readyPromise);
        if (!this.autoBoot || e.revision !== revision || e.spec !== originalSpec || this.get(projectId) !== e) throw new WorkerKilledError('configuration changed during bootstrap');
        this.applyReady(e, ready);
        return ready;
      } finally {
        this.pool.release(worker);
      }
    })();
    e.readiness = { kind: 'starting', promise };
    promise.catch(err => {
      if (e.readiness.kind !== 'starting' || e.readiness.promise !== promise) return; // superseded (invalidated, spec changed)
      if (err instanceof WorkerKilledError) {
        // Stop / Restart / toolchain change during the boot: not a Jest problem, nothing to report.
        e.readiness = { kind: 'cold' };
        this.log.debug(`project ${e.spec.displayName}: boot interrupted (${err.message})`);
        return;
      }
      const error = err instanceof WorkerInitError ? err.msg : { kind: 'unknown' as const, message: (err as Error).message };
      e.readiness = { kind: 'error', error, at: Date.now() };
      this.log.warn(`project ${e.spec.displayName}: ${error.kind}: ${error.message}`);
      this.emitter.fire({ type: 'initError', projectId, error: e.readiness });
    });
    return promise;
  }

  /**
   * Forgets every learned config (Clear Caches): entries fall back to their static matchers until a
   * worker reports again. The persisted cache is cleared by the caller (ConfigCache.clear).
   */
  clearConfigCache(): void {
    for (const e of this.entries.values()) {
      this.resetToStatic(e);
      // The caller kills the workers; a cached `ready` would otherwise keep the entry from booting again.
      if (e.readiness.kind !== 'starting') e.readiness = { kind: 'cold' };
    }
  }

  private resetToStatic(e: ProjectEntry): void {
    e.revision = (e.revision ?? 0) + 1;
    e.configs = undefined;
    e.configsSource = 'static';
    e.matchers = this.staticMatchers(e.spec);
  }

  /** Called by the runner when any worker of the project reports ready (keeps configs fresh). */
  noteReady(projectId: string, ready: ReadyMsg): void {
    const e = this.entries.get(projectId);
    if (e) this.applyReady(e, ready);
  }

  private applyReady(e: ProjectEntry, ready: ReadyMsg): void {
    // The runner reports the worker's `ready` on every dispatch: rebuilding matchers and rewriting
    // the config cache is only needed for a ready the entry has not seen.
    if (e.readiness.kind === 'ready' && e.readiness.ready === ready) return;
    const first = e.readiness.kind !== 'ready';
    e.readiness = { kind: 'ready', ready, at: Date.now() };
    e.configs = ready.configs;
    e.configsSource = 'worker';
    e.matchers = this.matchersFromConfigs(e.spec, ready.configs);
    void this.configCache.set(e.spec.id, this.fingerprint(e.spec, ready.configs), ready.configs, ready.jestVersion);
    if (first) this.emitter.fire({ type: 'ready', projectId: e.spec.id, ready });
  }

  /**
   * Identity of the inputs a cached config was resolved from: the spec plus a cheap content signature
   * (mtime + size) of the config file (or the implicit `jest.config.*` candidates), package.json and the
   * setup files the configs name, so an edit made while VS Code was closed invalidates the cached matchers.
   */
  private fingerprint(spec: ProjectSpec, configs: readonly ResolvedConfigSummary[]): string {
    const files = new Set<string>([path.join(spec.packageDir, 'package.json')]);
    if (spec.configFile) files.add(spec.configFile);
    if (spec.configArg) files.add(spec.configArg);
    // Implicit config (the common single `jest.config.*`): every name Jest would pick up, so an edit,
    // a new file or a deleted one changes the signature.
    else for (const ext of JEST_CONFIG_EXT_ORDER[30]) files.add(path.join(spec.packageDir, `jest.config${ext}`));
    for (const c of configs) {
      if (c.globalSetup) files.add(c.globalSetup);
      if (c.testEnvironment && path.isAbsolute(c.testEnvironment)) files.add(c.testEnvironment);
    }
    const sig = [...files].map(f => {
      try {
        if (f === spec.configFile) return `${f}@${createHash('sha256').update(fs.readFileSync(f)).digest('hex')}`;
        const st = fs.statSync(f); return `${f}@${st.mtimeMs}:${st.size}`;
      } catch { return `${f}@-`; }
    });
    return `${JSON.stringify(spec)}|${spec.id}|${spec.jestVersion}|${spec.configArg ?? ''}|${spec.cliFilters.testPathIgnorePatterns.join(',')}|${sig.join(';')}`;
  }

  private matchersFromConfigs(spec: ProjectSpec, configs: ResolvedConfigSummary[]): TestFileMatcher[] {
    const major = jestMajor(spec.jestVersion ?? '29.0.0');
    return configs.map(c => filteredMatcher({
      rootDir: c.rootDir, displayName: c.displayName, roots: c.roots, testMatch: c.testMatch, testRegex: c.testRegex,
      testPathIgnorePatterns: c.testPathIgnorePatterns, modulePathIgnorePatterns: c.modulePathIgnorePatterns,
    }, spec, major));
  }

  /** Matchers before the worker has reported: Jest defaults per major. */
  private staticMatchers(spec: ProjectSpec): TestFileMatcher[] {
    const major = jestMajor(spec.jestVersion ?? '29.0.0');
    const d = jestDefaultsFor(major);
    return [filteredMatcher({ rootDir: spec.packageDir, testMatch: d.testMatch, testPathIgnorePatterns: d.testPathIgnorePatterns }, spec, major)];
  }

  // ------------------------------------------------------------------ invalidation

  /**
   * Recycles a project's workers because `paths` (toolchain files: configs, setup files, transformers)
   * changed, e.g. by an unsaved edit. Same path as a watched file change: coalesced, runs cancelled
   * through the `invalidated` event before workers come back with the new config.
   */
  invalidate(projectId: string, paths: readonly string[]): void {
    if (!this.entries.has(projectId)) return;
    for (const p of paths) this.queueInvalidation(projectId, p);
  }

  private onToolchainFileChanged(fsPath: string): void {
    if (fsPath.includes(`${path.sep}node_modules${path.sep}`)) return;
    const name = path.basename(fsPath);
    // Native configs are independent; Wallaby is only an import source. Other toolchain files may
    // be shared by several Jest configs, so keep the existing conservative invalidation for those.
    if (!/^wallaby(?:\..+)?\.js$/.test(name)) for (const e of this.all()) {
      const affected = HYPER_CONFIG_NAME.test(name) ? e.spec.configFile === fsPath : isUnder(fsPath, e.spec.packageDir) || e.spec.configArg === fsPath;
      if (affected) this.queueInvalidation(e.spec.id, fsPath);
    }
    this.queueInvalidation('*', fsPath);
  }

  private queueInvalidation(id: string, fsPath: string): void {
    const set = this.pendingInvalidations.get(id) ?? new Set<string>();
    set.add(fsPath);
    this.pendingInvalidations.set(id, set);
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer);
    this.invalidateTimer = setTimeout(() => this.flushInvalidations(), 500);
  }

  private flushInvalidations(): void {
    const pending = this.pendingInvalidations;
    this.pendingInvalidations = new Map();
    for (const [id, paths] of pending) {
      if (id === '*') continue;
      const e = this.entries.get(id);
      if (!e) continue;
      this.log.info(`project ${e.spec.displayName}: toolchain changed (${[...paths].map(p => path.basename(p)).join(', ')}); recycling workers`);
      this.pool.killProject(id, 'toolchain changed');
      e.readiness = { kind: 'cold' };
      this.resetToStatic(e);
      this.emitter.fire({ type: 'invalidated', projectId: id, reason: 'config', paths: [...paths] });
    }
    // Reload native scope and selection before any replacement runs are scheduled.
    if (pending.size) void this.refresh();
  }

  dispose(): void {
    if (this.invalidateTimer) clearTimeout(this.invalidateTimer);
    this.discovery.dispose();
    this.disposables.forEach(d => d.dispose());
    this.emitter.dispose();
  }
}
