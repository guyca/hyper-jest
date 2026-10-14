import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface AssertionResult {
  title: string;
  status: string;
  failureMessages: string[];
}

describe('unit-test TypeScript transform', () => {
  let directory: string;
  let assertions: AssertionResult[];

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hyperjest-transform-'));
    const tests = path.join(directory, 'tests');
    fs.mkdirSync(tests);
    const fixtures: Record<string, string> = {
      'dependency.ts': `export const value: string = 'actual';\n`,
      'dynamic.ts': `export const answer: number = 42;\n`,
      'plain.test.ts': [
        'interface RemovedByCompilation {',
        '  value: string;',
        '}',
        '',
        'function fail(message: string): never {',
        '  throw new Error(message);',
        '}',
        '',
        "test('plain TypeScript stack', () => {",
        "  fail('plain stack marker');",
        '});',
      ].join('\n'),
      'hoisted.test.ts': [
        "import { value } from './dependency';",
        '',
        'interface RemovedByCompilation {',
        '  value: string;',
        '}',
        '',
        "jest.mock('./dependency', () => ({ value: 'mocked' }));",
        '',
        "test('mock precedes imported module', () => {",
        "  expect(value).toBe('mocked');",
        '});',
        '',
        "test('hoisted TypeScript stack', () => {",
        "  throw new Error('hoisted stack marker');",
        '});',
      ].join('\n'),
      'dynamic.test.ts': [
        "test('dynamic import works without VM modules', async () => {",
        "  const module = await import('./dynamic');",
        '  expect(module.answer).toBe(42);',
        '});',
      ].join('\n'),
    };
    for (const [name, source] of Object.entries(fixtures)) fs.writeFileSync(path.join(tests, name), source);
    const report = path.join(directory, 'results.json');
    const result = spawnSync(process.execPath, [
      require.resolve('jest/bin/jest'), '--runInBand', '--no-cache', '--json', `--outputFile=${report}`,
      '--config', JSON.stringify({
        rootDir: directory,
        testEnvironment: 'node',
        testMatch: ['<rootDir>/tests/*.test.ts'],
        transform: { '^.+\\.ts$': path.resolve(__dirname, '../jest-esbuild-transform.cjs') },
      }),
    ], {
      encoding: 'utf8', timeout: 15000,
      env: { ...process.env, NODE_OPTIONS: '', FORCE_COLOR: '0' },
    });
    if (result.error) throw result.error;
    if (!fs.existsSync(report)) throw new Error(`Nested Jest did not produce a report: ${result.stderr}`);
    const parsed = JSON.parse(fs.readFileSync(report, 'utf8')) as {
      numFailedTests: number;
      numPassedTests: number;
      testResults: { assertionResults: AssertionResult[] }[];
    };
    // Only the two deliberate stack-trace failures may fail in this fixture run.
    expect(result.status).toBe(1);
    expect(parsed.numFailedTests).toBe(2);
    expect(parsed.numPassedTests).toBe(2);
    assertions = parsed.testResults.flatMap(file => file.assertionResults);
  });

  afterAll(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('maps a TypeScript stack trace without mock hoisting to its original line', () => {
    const failure = assertions.find(result => result.title === 'plain TypeScript stack')!;
    expect(failure.failureMessages.join('\n')).toContain('plain stack marker');
    expect(failure.failureMessages.join('\n')).toMatch(/plain\.test\.ts:6:\d+/);
  });

  it('composes the mock-hoisting map back to the original TypeScript line', () => {
    const failure = assertions.find(result => result.title === 'hoisted TypeScript stack')!;
    expect(failure.failureMessages.join('\n')).toContain('hoisted stack marker');
    expect(failure.failureMessages.join('\n')).toMatch(/hoisted\.test\.ts:14:\d+/);
  });

  it('hoists jest.mock above module imports', () => {
    expect(assertions.find(result => result.title === 'mock precedes imported module')?.status).toBe('passed');
  });

  it('lowers dynamic imports for the CommonJS Jest runtime', () => {
    expect(assertions.find(result => result.title === 'dynamic import works without VM modules')?.status).toBe('passed');
  });
});
