/**
 * Environment for every child process HyperJest spawns (warm workers, CLI runs, debug launches).
 * Pure; no 'vscode'.
 */
import * as path from 'path';

/** Env vars that make Jest 30.4+ pick its "agent" reporter; they must never leak into test runs. */
export const AGENT_REPORTER_TRIGGERS = [
  'AI_AGENT', 'AUGMENT_AGENT', 'CLAUDE_CODE', 'CLAUDECODE', 'CODEX_SANDBOX', 'CODEX_THREAD_ID',
  'CURSOR_AGENT', 'GEMINI_CLI', 'GOOSE_PROVIDER', 'OPENCODE', 'REPL_ID',
];

/** Extension-host leftovers that must not reach a plain node child. */
export const HOST_ONLY_VARS = ['ELECTRON_RUN_AS_NODE', 'VSCODE_INSPECTOR_OPTIONS', 'NODE_OPTIONS_VSCODE', 'VSCODE_NLS_CONFIG', 'VSCODE_HANDLES_UNCAUGHT_ERRORS'];

export interface ChildEnvInput {
  base: NodeJS.ProcessEnv;
  nodePath: string;
  /** Project-flavor env (e.g. shono) applied after sanitisation. */
  projectEnv?: Record<string, string>;
  /** User `hyperjest.env`, applied last. */
  userEnv?: Record<string, string>;
  extra?: Record<string, string>;
  /** Keep ELECTRON_RUN_AS_NODE=1 (only when the node is the extension host's Electron binary). */
  electronAsNode?: boolean;
}

export function buildChildEnv(input: ChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.base)) {
    if (v === undefined) continue;
    if (HOST_ONLY_VARS.includes(k) || AGENT_REPORTER_TRIGGERS.includes(k)) continue;
    env[k] = v;
  }
  if (input.electronAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  env.NODE_ENV ??= 'test';
  env.BABEL_ENV ??= 'test';
  env.FORCE_COLOR = '0';
  env.NO_COLOR = '1';
  env.CI ??= '';
  delete env.CI; // leave CI detection to the project unless the user sets it
  const nodeDir = path.dirname(input.nodePath);
  env.PATH = env.PATH ? `${nodeDir}${path.delimiter}${env.PATH}` : nodeDir;
  // NODE_PATH from project env must APPEND to an existing NODE_PATH, not replace it.
  if (input.projectEnv) {
    for (const [k, v] of Object.entries(input.projectEnv)) {
      env[k] = k === 'NODE_PATH' && env.NODE_PATH ? `${env.NODE_PATH}${path.delimiter}${v}` : v;
    }
  }
  Object.assign(env, input.userEnv ?? {}, input.extra ?? {});
  return env;
}
