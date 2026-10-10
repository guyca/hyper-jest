/**
 * Stack-trace helpers: ANSI stripping, V8 frame parsing into protocol `Frame`s, message/stack
 * splitting. Pure; no Jest imports (jest-message-util is used by callers where available, this is
 * the dependency-free core that also runs in tests).
 */
import { fileURLToPath } from 'url';
import type { Frame } from '../core/protocol';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/**
 * `    at fn (file:line:col)` | `    at file:line:col` | `    at async fn (file:line:col)`
 * | `    at new Foo (file:line:col)` | `    at Object.<anonymous> (file:line:col)`.
 * Windows drive letters and `file://` URLs are handled; `eval at` frames are ignored.
 */
const FRAME_RE = /^\s*at\s+(?:async\s+)?(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;

export function parseStackLine(line: string): Frame | null {
  const m = FRAME_RE.exec(line);
  if (!m) return null;
  let file = m[2];
  if (file.startsWith('(')) file = file.slice(1);
  if (file.startsWith('file://')) {
    try { file = fileURLToPath(file); } catch { return null; }
  }
  const frame: Frame = { file, line: Number(m[3]), column: Number(m[4]) };
  if (m[1]) frame.functionName = m[1].trim();
  return frame;
}

/** HyperJest worker modules as they appear after source mapping (`<ext>/src/worker/<module>.ts`). */
export const HYPERJEST_WORKER_SOURCE_RE =
  /[\\/]src[\\/]worker[\\/](?:hyperjestWorker|envWrapper|warmEngine|stacks|ipc|coverageDiff|transformHooks|overlayFs|depGraph|jestChain|configSummary|probeTransformer)\.ts$/;

/** Frames nobody wants to see as an "error source": Node internals, node_modules, eval, our own bundle. */
export function isNoiseFrame(file: string, extraNoise: RegExp[] = []): boolean {
  if (!file) return true;
  if (file.startsWith('node:') || file.startsWith('internal/') || file === '[eval]' || file === '<anonymous>') return true;
  if (/[\\/]node_modules[\\/]/.test(file)) return true;
  // Our own bundle, and its TypeScript sources (source-map-support maps dist/worker/*.cjs frames back to them).
  if (/[\\/]dist[\\/]worker[\\/]/.test(file) || /hyperjestWorker\.cjs$/.test(file)) return true;
  if (HYPERJEST_WORKER_SOURCE_RE.test(file)) return true;
  return extraNoise.some(re => re.test(file));
}

export interface ParseFramesOptions {
  /** Drop noise frames (default true). When every frame is noise, the noise frames are returned instead. */
  skipNoise?: boolean;
  extraNoise?: RegExp[];
  /** Only keep absolute paths (default true). */
  absoluteOnly?: boolean;
}

export function parseFrames(stack: string | undefined | null, opts: ParseFramesOptions = {}): Frame[] {
  if (!stack) return [];
  const all: Frame[] = [];
  for (const line of stripAnsi(stack).split('\n')) {
    const f = parseStackLine(line);
    if (!f) continue;
    if (opts.absoluteOnly !== false && !isAbsoluteLike(f.file)) continue;
    all.push(f);
  }
  if (opts.skipNoise === false) return all;
  const clean = all.filter(f => !isNoiseFrame(f.file, opts.extraNoise));
  return clean.length ? clean : all;
}

function isAbsoluteLike(file: string): boolean {
  return file.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(file) || file.startsWith('\\\\');
}

/** The first non-noise frame, or undefined when there is none at all. */
export function topUserFrame(stack: string | undefined | null, extraNoise: RegExp[] = []): Frame | undefined {
  if (!stack) return undefined;
  for (const line of stripAnsi(stack).split('\n')) {
    const f = parseStackLine(line);
    if (f && isAbsoluteLike(f.file) && !isNoiseFrame(f.file, extraNoise)) return f;
  }
  return undefined;
}

/** Splits Jest's `error.stack`-style text into the message and the `    at ...` block. */
export function splitMessageStack(text: string): { message: string; stack: string } {
  const lines = stripAnsi(text ?? '').split('\n');
  const idx = lines.findIndex(l => /^\s+at\s/.test(l));
  if (idx < 0) return { message: lines.join('\n').trimEnd(), stack: '' };
  return { message: lines.slice(0, idx).join('\n').trimEnd(), stack: lines.slice(idx).join('\n') };
}
