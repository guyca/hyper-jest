import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findHyperConfigs, hyperConfigName, importWallaby, scopeMatches, validateHyperConfig } from '../../../src/core/hyperConfig';
import { loadConfigModule, prepareHyperConfig } from '../../../src/discovery/hyperConfigLoader';
import { createMemFs } from './memFs';

const runtime = { nodePath: process.execPath, nodeArgs: [], env: {} };
const wallaby = { autoDetect: true, testFramework: { configFile: './jest.config.js' }, files: ['src/**/*'], tests: ['tests/unit/**/*.test.ts'], env: { params: { env: 'TOKEN="two words" NODE_OPTIONS="--max_old_space_size=4096"', runner: '--no-warnings' } } };

describe('Wallaby import and native scope', () => {
  it('imports workspace test scope, literal environment and Node arguments', () => {
    expect(importWallaby(wallaby)).toEqual({ jestConfig: './jest.config.js', files: ['src/**/*'], tests: ['tests/unit/**/*.test.ts'], env: { TOKEN: 'two words' }, nodeArgs: ['--max_old_space_size=4096', '--no-warnings'] });
    expect(importWallaby({ env: { params: { env: `NODE_OPTIONS='--require "/p/space here.js"'` } } }).nodeArgs).toEqual(['--require', '/p/space here.js']);
    expect(() => importWallaby({ env: { params: { env: 'VALUE="unfinished' } } })).toThrow('Unclosed quote');
  });
  it('keeps exclusion precedence and distinguishes missing from empty patterns', () => {
    const config = importWallaby({ tests: [{ pattern: 'tests/excluded.test.ts', ignore: true }, 'tests/**/*.test.ts'] });
    expect(scopeMatches('/p/tests/a.test.ts', '/p', config.tests)).toBe(true);
    expect(scopeMatches('/p/tests/excluded.test.ts', '/p', config.tests)).toBe(false);
    expect(scopeMatches('/p/tests/a.test.ts', '/p', [])).toBe(false);
    expect(scopeMatches('/p/tests/a.test.ts', '/p', undefined)).toBe(true);
    expect(scopeMatches('/p/tests/.hidden/a.test.ts', '/p', config.tests)).toBe(false);
    expect(importWallaby({ tests: [{ pattern: '!tests/a.test.ts', ignore: true }] }).tests).toEqual(['tests/a.test.ts']);
  });
  it('rejects options that cannot be faithfully imported', () => {
    expect(() => importWallaby({ ...wallaby, setup: 'unsupported' })).toThrow('setup');
    expect(() => importWallaby({ tests: [{ pattern: '**/*', instrument: false }] })).toThrow('instrument');
    expect(() => importWallaby({ env: { params: { env: 'TOKEN=$(command)' } } })).toThrow('literal');
    expect(() => validateHyperConfig({ tests: 'tests/*' })).toThrow('array');
  });
  it('discovers named configs without crossing packages or exclusions', () => {
    const mem = createMemFs({ '/p/wallaby.js': '', '/p/wallaby.unit.js': '', '/p/hyperjest.config.js': '', '/p/tools/wallaby.js': '', '/p/child/package.json': '{}', '/p/child/wallaby.js': '', '/p/ignored/wallaby.js': '' });
    expect(findHyperConfigs('/p', mem, p => p.includes('/ignored')).map(f => f.file)).toEqual(['/p/hyperjest.config.js', '/p/hyperjest.unit.config.js', '/p/tools/hyperjest.config.js']);
    expect(hyperConfigName('wallaby.js')).toBe('hyperjest.config.js');
    expect(hyperConfigName('wallaby.unit.js')).toBe('hyperjest.unit.config.js');
  });
});

describe('bounded configuration loading and exclusive generation', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperjest-config-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it.each([false, true])('loads factories and generates an independent config (ESM=%s)', async esm => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: esm ? 'module' : 'commonjs' }));
    const source = path.join(dir, 'wallaby.js'), file = path.join(dir, 'hyperjest.config.js');
    fs.writeFileSync(source, `${esm ? 'export default' : 'module.exports ='} () => (${JSON.stringify(wallaby)});`);
    const result = await prepareHyperConfig({ file, wallaby: source }, runtime);
    expect(result.error).toBeUndefined();
    expect(result.config?.tests).toEqual(wallaby.tests);
    const generated = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(source, 'throw new Error("must not be loaded again")');
    expect(await prepareHyperConfig({ file, wallaby: source }, runtime)).toEqual(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(generated);
    fs.writeFileSync(file, `${esm ? 'export default' : 'module.exports ='} { tests: [] };`);
    expect((await prepareHyperConfig({ file, wallaby: source }, runtime)).config?.tests).toEqual([]);
  });
  it('does not publish a partial config when Wallaby uses a hook', async () => {
    const source = path.join(dir, 'wallaby.js'), file = path.join(dir, 'hyperjest.config.js');
    fs.writeFileSync(source, 'module.exports = () => ({ autoDetect: true, setup() {} });');
    expect((await prepareHyperConfig({ file, wallaby: source }, runtime)).error).toMatch(/setup/);
    expect(fs.existsSync(file)).toBe(false);
  });
  it('kills a config that never completes', async () => {
    const file = path.join(dir, 'hyperjest.config.js');
    fs.writeFileSync(file, 'module.exports = () => { while(true) {} };');
    await expect(loadConfigModule(file, runtime, 100)).rejects.toThrow('timed out');
  });
});
