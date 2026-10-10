import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Readable } from 'stream';
import { buildChildEnv } from '../core/childEnv';
import { importWallaby, validateHyperConfig, type HyperConfigFile, type LoadedHyperConfig } from '../core/hyperConfig';
import type { ProjectSpec } from '../core/protocol';

// A fresh process prevents require-cache leaks and keeps arbitrary configuration code off the host.
// fd 3 is independent of console output. Non-data values must not silently disappear in JSON.
const LOAD = `
(async () => {
  try {
    const {pathToFileURL} = require('url');
    const mod = await import(pathToFileURL(process.argv[1]).href);
    let value = mod.default;
    if (typeof value === 'function') value = await value();
    const json = JSON.stringify(value, (key, item) => {
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint') throw new Error('Unsupported executable or non-data option: ' + key);
      return item;
    });
    if (!json) throw new Error('Configuration must export an object');
    require('fs').writeFileSync(3, JSON.stringify({value: JSON.parse(json)}));
  } catch (error) {
    require('fs').writeFileSync(3, JSON.stringify({error: error.message}));
  }
  process.exit(0);
})();`;

export function loadConfigModule(file: string, spec: Pick<ProjectSpec, 'nodePath' | 'env' | 'nodeArgs'>, timeoutMs = 10000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const nodePath = spec.nodePath ?? process.execPath;
    const child = spawn(nodePath, [...spec.nodeArgs, '-e', LOAD, file], {
      cwd: path.dirname(file),
      env: buildChildEnv({ base: process.env, nodePath, projectEnv: spec.env, electronAsNode: spec.env.ELECTRON_RUN_AS_NODE === '1' }),
      stdio: ['ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let payload = '', stderr = '', settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Configuration load timed out: ${file}`)), timeoutMs);
    child.on('error', e => finish(e));
    child.stderr?.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-10000); });
    (child.stdio[3] as Readable).on('data', (b: Buffer) => {
      payload += b.toString();
      if (payload.length > 1024 * 1024) finish(new Error('Configuration exceeds 1 MB'));
    });
    child.on('close', code => {
      if (settled) return;
      try {
        if (code !== 0) throw new Error(`Configuration process exited ${code}: ${stderr}`);
        const result = JSON.parse(payload);
        if (result.error) throw new Error(result.error);
        finish(undefined, result.value);
      } catch (e) { finish(new Error(`${file}: ${(e as Error).message}`)); }
    });
  });
}

function isEsm(dir: string): boolean {
  for (;;) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).type === 'module'; } catch { /* ascend */ }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

export async function prepareHyperConfig(entry: HyperConfigFile, spec: Pick<ProjectSpec, 'nodePath' | 'env' | 'nodeArgs'>): Promise<LoadedHyperConfig> {
  try {
    if (!fs.existsSync(entry.file) && entry.wallaby) {
      const config = importWallaby(await loadConfigModule(entry.wallaby, spec));
      const source = `// Imported from ${path.basename(entry.wallaby)}. This independent file is never overwritten by HyperJest.\n${isEsm(path.dirname(entry.file)) ? 'export default' : 'module.exports ='} ${JSON.stringify(config, null, 2)};\n`;
      try { await fs.promises.writeFile(entry.file, source, { flag: 'wx' }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
    return { config: validateHyperConfig(await loadConfigModule(entry.file, spec)) };
  } catch (e) { return { error: (e as Error).message }; }
}
