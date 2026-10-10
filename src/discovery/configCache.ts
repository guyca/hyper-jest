import * as vscode from 'vscode';
import type { ResolvedConfigSummary } from '../core/protocol';

interface CachedEntry {
  fingerprint: string;
  configs: ResolvedConfigSummary[];
  jestVersion: string;
  savedAt: number;
}

/**
 * Persists each project's resolved Jest configs (from the worker's `ready` message) in global
 * storage, keyed by project id and a fingerprint of the files that influence the config. Lets the
 * Test Explorer show precise test-file lists before the project's worker has booted.
 *
 * The memento is the only copy: every read and write goes through it, so clearing the key (here or
 * through another `ConfigCache` on the same memento, e.g. "HyperJest: Clear Caches") cannot be undone
 * by a later `set()` re-persisting an in-memory map.
 */
export class ConfigCache {
  static readonly KEY = 'hyperjest.configCache.v1';

  constructor(private readonly memento: vscode.Memento) {}

  /**
   * The cached entry when its fingerprint matches. `fingerprint` may be computed from the entry itself
   * (e.g. a signature of the setup files its configs name).
   */
  get(projectId: string, fingerprint: string | ((entry: CachedEntry) => string)): CachedEntry | undefined {
    const e = this.read()[projectId];
    if (!e) return undefined;
    return e.fingerprint === (typeof fingerprint === 'function' ? fingerprint(e) : fingerprint) ? e : undefined;
  }

  async set(projectId: string, fingerprint: string, configs: ResolvedConfigSummary[], jestVersion: string): Promise<void> {
    // Copy: Memento.get may hand out its live value object.
    const data = { ...this.read(), [projectId]: { fingerprint, configs, jestVersion, savedAt: Date.now() } };
    await this.memento.update(ConfigCache.KEY, data);
  }

  async clear(): Promise<void> {
    await this.memento.update(ConfigCache.KEY, undefined);
  }

  private read(): Record<string, CachedEntry> {
    return this.memento.get<Record<string, CachedEntry>>(ConfigCache.KEY) ?? {};
  }
}
