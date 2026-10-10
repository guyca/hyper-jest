jest.mock('vscode', () => {
  const fake = jest.requireActual('../results/fakeVscode');
  const event = () => ({ dispose() {} });
  return { ...fake, RelativePattern: class { constructor(public base: string, public pattern: string) {} }, workspace: { ...fake.workspace, workspaceFolders: [],
    createFileSystemWatcher: () => ({ dispose() {}, onDidChange: event, onDidCreate: event, onDidDelete: event }),
    onDidChangeWorkspaceFolders: event, findFiles: jest.fn(),
  } };
});
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectRegistry } from '../../../src/discovery/projectRegistry';
import { DEFAULT_SETTINGS, type HyperJestSettings } from '../../../src/core/settingsModel';
import { noopLogger } from '../../../src/core/logger';

const fixture = path.resolve(__dirname, '../../fixtures/config-project');
const modules = path.resolve(__dirname, '../../../node_modules');
let dir: string, registry: ProjectRegistry, settings: HyperJestSettings;
const pool = { registerProject: jest.fn(), killProject: jest.fn(), workersOf: () => [], acquire: jest.fn(async () => { throw new Error('CLI discovery must not boot a worker'); }) };

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperjest-selection-')));
  fs.cpSync(fixture, dir, { recursive: true });
  fs.symlinkSync(modules, path.join(dir, 'node_modules'), 'dir');
  settings = { ...DEFAULT_SETTINGS, engine: 'cli', nodePath: process.execPath, snapshots: { updateMode: 'none' } };
  (vscode.workspace.findFiles as jest.Mock).mockImplementation(async (pattern: string | { base: string }) => {
    const files = typeof pattern === 'string' ? ['package.json'] : ['tests/unit/pass.test.js', 'tests/integration/external.test.js'];
    return files.map(f => vscode.Uri.file(path.join(dir, f)));
  });
  registry = new ProjectRegistry(pool as any, () => settings, noopLogger, { get: () => undefined, update: async () => undefined } as any);
});
afterEach(() => { registry.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });

it('imports Wallaby before enumeration and resolves CLI matchers without executing integration tests', async () => {
  await registry.refresh();
  const selected = registry.all().filter(e => e.spec.selected);
  expect(selected).toHaveLength(1);
  const spec = selected[0].spec;
  expect(spec.configKey).toBe('hyperjest.config.js');
  expect(fs.existsSync(spec.configFile!)).toBe(true);
  expect(await registry.testFilesOf(spec.id)).toEqual([path.join(dir, 'tests/unit/pass.test.js')]);
  expect(registry.acceptsTest(spec.id, path.join(dir, 'tests/integration/external.test.js'))).toBe(false);
  expect(spec.nodeArgs).toContain('--max_old_space_size=4096');
  expect(pool.acquire).not.toHaveBeenCalled();
  settings = { ...settings, projects: [{ packageDir: dir, configFiles: ['hyperjest.config.js', 'jest.integration.config.js'] }] };
  await registry.refresh();
  const integration = registry.all().find(e => e.spec.configKey === 'jest.integration.config.js')!;
  expect(integration.spec.selected).toBe(true);
  expect(await registry.testFilesOf(integration.spec.id)).toEqual([path.join(dir, 'tests/integration/external.test.js')]);
});

it('reloads edited scopes and supports explicitly disabling all configs', async () => {
  await registry.refresh();
  const id = registry.all().find(e => e.spec.selected)!.spec.id;
  await registry.testFilesOf(id);
  fs.writeFileSync(path.join(dir, 'hyperjest.config.js'), "module.exports = {jestConfig: './jest.config.js', tests: []};");
  await registry.refresh();
  expect(await registry.testFilesOf(id)).toEqual([]);
  expect(pool.killProject).toHaveBeenCalledWith(id, 'spec changed');
  settings = { ...settings, projects: [{ packageDir: dir, configFiles: [] }] };
  await registry.refresh();
  expect(registry.projectsFor(path.join(dir, 'tests/unit/pass.test.js'))).toEqual([]);
});

it('uses the main test script when no HyperJest/Wallaby config exists', async () => {
  fs.unlinkSync(path.join(dir, 'wallaby.js'));
  await registry.refresh();
  const selected = registry.all().filter(e => e.spec.selected);
  expect(selected.map(e => e.spec.configKey)).toEqual(['jest.config.js']);
  expect(await registry.testFilesOf(selected[0].spec.id)).toEqual([path.join(dir, 'tests/unit/pass.test.js')]);
});
