import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { build } from 'esbuild';
import { discoverProjectsAsync } from '../../../src/core/projectSpec';
import { DEFAULT_SETTINGS } from '../../../src/core/settingsModel';
import { WorkerDiscoveryExecutor } from '../../../src/discovery/discoveryExecutor';
import type { WorkerDiscoveryInput } from '../../../src/discovery/discoveryProtocol';
import { noopLogger } from '../../../src/core/logger';

const sourceFixture = path.resolve(__dirname, '../../fixtures/config-project');
const modules = path.resolve(__dirname, '../../../node_modules');
let dir: string;
let workerEntry: string;
let projectDir: string;
let packageJsonPaths: string[];

function input(cache = new Map<string, string | null>()): WorkerDiscoveryInput {
  return {
    packageJsonPaths,
    settings: { ...DEFAULT_SETTINGS, nodePath: process.execPath },
    homeDir: os.homedir(),
    platform: process.platform,
    env: { ...process.env },
    workspaceFolders: [dir],
    nodeVersionCache: cache,
    electronExecPath: process.execPath,
    hostNodeVersion: process.versions.node,
  };
}

beforeAll(async () => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hyperjest-discovery-worker-')));
  workerEntry = path.join(dir, 'discoveryWorker.js');
  await build({
    entryPoints: [path.resolve(__dirname, '../../../src/discovery/discoveryWorker.ts')],
    outfile: workerEntry, bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
  });
  projectDir = path.join(dir, 'config-project');
  fs.cpSync(sourceFixture, projectDir, { recursive: true });
  fs.symlinkSync(modules, path.join(projectDir, 'node_modules'), 'dir');
  const plainDir = path.join(dir, 'plain');
  const invalidDir = path.join(dir, 'invalid');
  fs.mkdirSync(plainDir);
  fs.mkdirSync(invalidDir);
  fs.writeFileSync(path.join(plainDir, 'package.json'), JSON.stringify({ name: 'plain' }));
  fs.writeFileSync(path.join(invalidDir, 'package.json'), '{ invalid json');
  packageJsonPaths = [path.join(projectDir, 'package.json'), path.join(plainDir, 'package.json'), path.join(invalidDir, 'package.json')];
});

afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

it('matches in-process discovery, preserves skip reasons, and merges the warm Node cache', async () => {
  const expectedInput = input();
  const expected = await discoverProjectsAsync(expectedInput);
  const workerInput = input();
  const log = { ...noopLogger, warn: jest.fn() };
  const executor = new WorkerDiscoveryExecutor(workerEntry, log);
  try {
    executor.beginRefresh();
    const actual = await executor.discover(workerInput);
    expect(log.warn).not.toHaveBeenCalled();
    expect(actual).toEqual(expected);
    expect(actual.skipped.map(s => s.reason)).toEqual(expect.arrayContaining(['invalidJson', 'noTests']));
    expect(workerInput.nodeVersionCache).toEqual(expectedInput.nodeVersionCache);
    expect(workerInput.nodeVersionCache!.size).toBeGreaterThan(0);
    const warmCache = new Map(workerInput.nodeVersionCache);
    executor.beginRefresh();
    expect(await executor.discover(workerInput)).toEqual(actual);
    expect(workerInput.nodeVersionCache).toEqual(warmCache);
  } finally { executor.dispose(); }
});

it('lets a host timer run before a warm worker completes a CPU-heavy discovery', async () => {
  const log = { ...noopLogger, warn: jest.fn() };
  const executor = new WorkerDiscoveryExecutor(workerEntry, log);
  const bigDir = path.join(dir, 'large-package');
  fs.mkdirSync(bigDir);
  fs.writeFileSync(path.join(bigDir, 'package.json'), JSON.stringify({
    name: 'large-package', description: 'x'.repeat(16 * 1024 * 1024),
    scripts: { test: 'jest' }, devDependencies: { jest: '^30' },
  }));
  fs.symlinkSync(modules, path.join(bigDir, 'node_modules'), 'dir');
  try {
    executor.beginRefresh();
    await executor.discover(input()); // warm startup and Node version lookup first
    let finished = false;
    const longDiscovery = executor.discover({ ...input(), packageJsonPaths: [path.join(bigDir, 'package.json')] })
      .then(() => { finished = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    await longDiscovery;
    expect(log.warn).not.toHaveBeenCalled();
  } finally { executor.dispose(); }
});

it('uses host discovery for the rest of a failed refresh, then retries a worker on the next refresh', async () => {
  const recoverEntry = path.join(dir, 'recover-startup.js');
  const log = { ...noopLogger, warn: jest.fn() };
  const executor = new WorkerDiscoveryExecutor(recoverEntry, log);
  try {
    const expected = await discoverProjectsAsync(input());
    executor.beginRefresh();
    expect(await executor.discover(input())).toEqual(expected);
    expect(log.warn).toHaveBeenCalledTimes(1);
    fs.writeFileSync(recoverEntry, "const { parentPort } = require('worker_threads'); parentPort.on('message', ({ id }) => parentPort.postMessage({ id, result: { specs: [], skipped: [] }, nodeVersionCacheEntries: [] }));\n");
    // A two-pass refresh remains on the host after its first worker transport failure.
    expect(await executor.discover(input())).toEqual(expected);
    expect(log.warn).toHaveBeenCalledTimes(1);
    executor.beginRefresh();
    expect(await executor.discover(input())).toEqual({ specs: [], skipped: [] });
    expect(log.warn).toHaveBeenCalledTimes(1);
  } finally { executor.dispose(); }
});

it('falls back after an unexpected exit and recovers on the next request', async () => {
  const recoverEntry = path.join(dir, 'recover-exit.js');
  fs.writeFileSync(recoverEntry, "require('worker_threads').parentPort.on('message', () => process.exit(7));\n");
  const log = { ...noopLogger, warn: jest.fn() };
  const executor = new WorkerDiscoveryExecutor(recoverEntry, log);
  try {
    const expected = await discoverProjectsAsync(input());
    executor.beginRefresh();
    expect(await executor.discover(input())).toEqual(expected);
    expect(log.warn).toHaveBeenCalledTimes(1);
    fs.copyFileSync(workerEntry, recoverEntry);
    executor.beginRefresh();
    expect(await executor.discover(input())).toEqual(expected);
    expect(log.warn).toHaveBeenCalledTimes(1);
  } finally { executor.dispose(); }
});

it('propagates discovery errors without falling back', async () => {
  const errorEntry = path.join(dir, 'error.js');
  fs.writeFileSync(errorEntry, "require('worker_threads').parentPort.on('message', ({ id }) => require('worker_threads').parentPort.postMessage({ id, error: { message: 'discovery failed' } }));\n");
  const log = { ...noopLogger, warn: jest.fn() };
  const executor = new WorkerDiscoveryExecutor(errorEntry, log);
  try {
    executor.beginRefresh();
    await expect(executor.discover(input())).rejects.toThrow('discovery failed');
    expect(log.warn).not.toHaveBeenCalled();
  } finally { executor.dispose(); }
});

it('rejects pending requests on disposal and does not restart', async () => {
  const slowEntry = path.join(dir, 'slow.js');
  fs.writeFileSync(slowEntry, "require('worker_threads').parentPort.on('message', () => setTimeout(() => {}, 10000));\n");
  const executor = new WorkerDiscoveryExecutor(slowEntry, noopLogger);
  executor.beginRefresh();
  const pending = executor.discover(input());
  await new Promise<void>(resolve => setTimeout(resolve, 30));
  executor.dispose();
  await expect(pending).rejects.toThrow('Discovery executor disposed');
  await expect(executor.discover(input())).rejects.toThrow('Discovery executor disposed');
});
