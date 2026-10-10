/**
 * ANSI escape-sequence stripping, shared by the reporter (worker bundle), the warm engine and the
 * host. Jest's `expect` messages, `failureMessage` and console output may carry chalk colors even
 * when `FORCE_COLOR=0` is set late; every text that reaches the UI goes through `stripAnsi`.
 *
 * Pure; no 'vscode'.
 */

/**
 * Matches CSI sequences (`ESC [ ... final`), OSC sequences (`ESC ] ... BEL|ST`) and the rare
 * single-character escapes chalk / supports-hyperlinks emit. Kept deliberately broad: a stray
 * escape left in an editor decoration is worse than an over-eager strip.
 */
// eslint-disable-next-line no-control-regex
export const ANSI_RE = /[\u001B\u009B](?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

/** Removes ANSI escape sequences. Non-string input is returned unchanged (defensive for serialized data). */
export function stripAnsi<T>(text: T): T {
  if (typeof text !== 'string') return text;
  return (text as string).replace(ANSI_RE, '') as unknown as T;
}

/** True when the text contains at least one ANSI escape sequence. */
export function hasAnsi(text: string): boolean {
  ANSI_RE.lastIndex = 0;
  const result = ANSI_RE.test(text);
  ANSI_RE.lastIndex = 0;
  return result;
}
