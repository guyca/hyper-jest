/** Minimal logger contract so core/worker code never imports 'vscode'. */
export interface Logger {
  trace(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string | Error, ...args: unknown[]): void;
}

export const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Logger that writes to stderr with a prefix (used inside worker processes). */
export function stderrLogger(prefix: string): Logger {
  const w = (level: string, msg: string | Error, args: unknown[]) => {
    const text = msg instanceof Error ? (msg.stack ?? msg.message) : msg;
    process.stderr.write(`[${prefix}] ${level} ${text}${args.length ? ' ' + args.map(a => safeString(a)).join(' ') : ''}\n`);
  };
  return {
    trace: (m, ...a) => w('TRACE', m, a),
    debug: (m, ...a) => w('DEBUG', m, a),
    info: (m, ...a) => w('INFO', m, a),
    warn: (m, ...a) => w('WARN', m, a),
    error: (m, ...a) => w('ERROR', m, a),
  };
}

export function safeString(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
