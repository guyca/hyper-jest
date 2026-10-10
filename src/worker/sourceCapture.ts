/** Source actually returned by Jest's transform cache, scoped to one test-file execution. */
import * as path from 'path';

const sources = new Map<string, string | null>();

export function resetSourceCapture(): void { sources.clear(); }

export function captureTransformedSource(filename: string, result: unknown): void {
  const text = (result as { originalCode?: unknown } | undefined)?.originalCode;
  if (typeof text !== 'string') return;
  const key = path.resolve(filename);
  // resetModules plus an edit during execution can mix revisions in one Istanbul counter object.
  if (sources.has(key) && sources.get(key) !== text) sources.set(key, null);
  else sources.set(key, text);
}

export function capturedSource(filename: string): string | undefined {
  return sources.get(path.resolve(filename)) ?? undefined;
}
