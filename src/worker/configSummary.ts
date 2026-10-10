/**
 * Builds the `ResolvedConfigSummary` the host receives in `ready` from a Jest ProjectConfig.
 * Regex values are reported as their `source` strings (RegExp does not survive JSON IPC).
 * Pure; no Jest imports.
 */
import type { ResolvedConfigSummary } from '../core/protocol';

/** `RegExp` -> source, string -> string, anything else -> String(). */
export function regexSource(v: unknown): string {
  if (v instanceof RegExp) return v.source;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { source?: unknown }).source === 'string') return (v as { source: string }).source;
  return String(v);
}

function stringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(regexSource);
  if (v === undefined || v === null || v === '') return [];
  return [regexSource(v)];
}

export function summarizeConfig(cfg: Record<string, any>, index: number): ResolvedConfigSummary {
  const displayName = cfg.displayName;
  return {
    index,
    displayName: typeof displayName === 'string' ? displayName : displayName && typeof displayName.name === 'string' ? displayName.name : undefined,
    rootDir: String(cfg.rootDir ?? ''),
    roots: stringArray(cfg.roots),
    testMatch: stringArray(cfg.testMatch),
    testRegex: stringArray(cfg.testRegex),
    testPathIgnorePatterns: stringArray(cfg.testPathIgnorePatterns),
    modulePathIgnorePatterns: stringArray(cfg.modulePathIgnorePatterns),
    moduleFileExtensions: stringArray(cfg.moduleFileExtensions),
    testEnvironment: String(cfg.testEnvironment ?? ''),
    globalSetup: typeof cfg.globalSetup === 'string' && cfg.globalSetup ? cfg.globalSetup : undefined,
    runner: String(cfg.runner ?? ''),
    cacheDirectory: String(cfg.cacheDirectory ?? ''),
  };
}

/** JSON replacer for `showConfig`: RegExp -> source string, functions -> tag, undefined kept out. */
export function configJsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof RegExp) return value.source;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'bigint') return value.toString();
  return value;
}
