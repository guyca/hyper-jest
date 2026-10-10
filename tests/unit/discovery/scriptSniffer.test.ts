import {
  allCommands, commandPriority, isE2eScriptName, isShonoConfigPath, isTestLikeScriptName, nodeOptionsToArgs, parseJestArgs, scriptPriority,
  sniffScripts, splitCommands, tokenize,
} from '../../../src/core/scriptSniffer';

const one = (script: string, extra: Record<string, string> = {}) => {
  const infos = sniffScripts({ test: script, ...extra });
  return infos.find(i => i.name === 'test')!.commands;
};

describe('scriptSniffer tokenizer', () => {
  it('handles quotes, escapes and control operators', () => {
    const toks = tokenize(`a "b c" 'd e' f\\ g && h || i ; j | k & l`);
    expect(toks.map(t => (t.op ? `<${t.text}>` : t.text))).toEqual(['a', 'b c', 'd e', 'f g', '<&&>', 'h', '<||>', 'i', '<;>', 'j', '<|>', 'k', '<&>', 'l']);
    expect(splitCommands(tokenize('a b && c "d && e"'))).toEqual([['a', 'b'], ['c', 'd && e']]);
    expect(tokenize('NODE_OPTIONS="--max-old-space-size=4096 --no-warnings" jest').map(t => t.text)).toEqual(['NODE_OPTIONS=--max-old-space-size=4096 --no-warnings', 'jest']);
  });
});

describe('parseJestArgs', () => {
  it('extracts config, ignore patterns (= and space forms, greedy arrays) and positionals', () => {
    expect(parseJestArgs(['--testPathIgnorePatterns=tests/integration'])).toMatchObject({ configArg: undefined, testPathIgnorePatterns: ['tests/integration'], testPathPatterns: [] });
    expect(parseJestArgs(['--config', 'jest.integration.config.js'])).toMatchObject({ configArg: 'jest.integration.config.js' });
    expect(parseJestArgs(['--config=cfg.js', '--maxWorkers=2'])).toMatchObject({ configArg: 'cfg.js', flags: { config: 'cfg.js', maxWorkers: '2' } });
    expect(parseJestArgs(['-c', 'jest.unit.config.js', './integration'])).toMatchObject({ configArg: 'jest.unit.config.js', testPathPatterns: ['./integration'], positional: ['./integration'] });
    expect(parseJestArgs(['--testPathIgnorePatterns', 'a', 'b', '--coverage', '--no-cache'])).toMatchObject({ testPathIgnorePatterns: ['a', 'b'], flags: { coverage: true, cache: false } });
    expect(parseJestArgs(['--testPathIgnorePatterns=a', 'b', '-u', '--', 'src/x.test.ts'])).toMatchObject({ testPathIgnorePatterns: ['a', 'b'], positional: ['src/x.test.ts'], flags: { u: true } });
    expect(parseJestArgs(['-t', 'my test', '--runInBand'])).toMatchObject({ testNamePattern: 'my test', flags: { runInBand: true } });
    expect(parseJestArgs(['--testPathPattern=src/.*\\.spec\\.ts'])).toMatchObject({ testPathPatterns: ['src/.*\\.spec\\.ts'] });
    expect(parseJestArgs(['-ui'])).toMatchObject({ flags: { u: true, i: true } });
  });
});

describe('sniffScripts classification', () => {
  it('recognises plain, wrapped and node-launched jest', () => {
    expect(one('jest --testPathIgnorePatterns=tests/integration')[0]).toMatchObject({ runner: 'jest', bin: 'jest', jest: { testPathIgnorePatterns: ['tests/integration'] } });
    expect(one('yarn jest --coverage')[0]).toMatchObject({ runner: 'jest', wrappers: ['yarn'], jest: { flags: { coverage: true } } });
    expect(one('npx jest -t "my test"')[0]).toMatchObject({ runner: 'jest', wrappers: ['npx'], jest: { testNamePattern: 'my test' } });
    expect(one('npx --no-install jest')[0]).toMatchObject({ runner: 'jest' });
    expect(one('node ../../node_modules/jest/bin/jest.js --runInBand')[0]).toMatchObject({ runner: 'jest', bin: '../../node_modules/jest/bin/jest.js', jest: { flags: { runInBand: true } } });
    expect(one('node --expose-gc ./node_modules/.bin/jest')[0]).toMatchObject({ runner: 'jest', env: { NODE_OPTIONS: '--expose-gc' } });
    expect(one('jest -c jest.unit.config.js && jest -c jest.integration.config.js ./integration').map(c => c.jest!.configArg)).toEqual(['jest.unit.config.js', 'jest.integration.config.js']);
    expect(one('jest -c jest.unit.config.js && jest -c jest.integration.config.js ./integration')[1].jest!.testPathPatterns).toEqual(['./integration']);
  });

  it('collects env prefixes from assignments, cross-env, env and export', () => {
    expect(one('cross-env NODE_ENV=test BABEL_ENV=test jest')[0]).toMatchObject({ runner: 'jest', wrappers: ['cross-env'], env: { NODE_ENV: 'test', BABEL_ENV: 'test' } });
    expect(one('env FOO=1 jest')[0]).toMatchObject({ runner: 'jest', env: { FOO: '1' } });
    expect(one('NODE_OPTIONS="--max-old-space-size=4096 --no-warnings" jest')[0].env).toEqual({ NODE_OPTIONS: '--max-old-space-size=4096 --no-warnings' });
    expect(nodeOptionsToArgs('--max-old-space-size=4096 --no-warnings')).toEqual(['--max-old-space-size=4096', '--no-warnings']);
    const cmds = one('export BABEL_ENV=test && yarn run shono:test && npm run test-e2e-sanity', { 'shono:test': 'shono testjs', 'test-e2e-sanity': 'node e2e/run.js' });
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toMatchObject({ runner: 'shono-testjs', script: 'shono:test', via: ['test'], env: { BABEL_ENV: 'test' } });
    expect(cmds[1]).toMatchObject({ runner: 'other', script: 'test-e2e-sanity', via: ['test'], bin: 'node e2e/run.js' });
  });

  it('recognises shono testjs in CLI and inlined forms', () => {
    expect(one('shono testjs')[0]).toMatchObject({ runner: 'shono-testjs', shono: { fileName: undefined, flags: [] } });
    expect(one('shono testjs headlessTests')[0].shono).toEqual({ fileName: 'headlessTests', flags: [] });
    expect(one('shono testjs -- --colors')[0].shono).toEqual({ fileName: undefined, flags: ['--colors'] });
    const inlined = one('USE_HEADLESS_PB=true NODE_PATH=${NODE_PATH:-}:../../../node_modules/@wix/wix-one-app-engine/node_modules:./node_modules RNTL_SKIP_AUTO_DETECT_FAKE_TIMERS=true NODE_OPTIONS=--max_old_space_size=8192 ../../../node_modules/jest/bin/jest.js -c ../../../node_modules/@wix/shono/node_modules/@wix/shono-testjs/dist/src/jestConfig.js --maxWorkers=1')[0];
    expect(inlined.runner).toBe('jest');
    expect(isShonoConfigPath(inlined.jest!.configArg)).toBe(true);
    expect(inlined.env).toEqual({ USE_HEADLESS_PB: 'true', NODE_PATH: '${NODE_PATH:-}:../../../node_modules/@wix/wix-one-app-engine/node_modules:./node_modules', RNTL_SKIP_AUTO_DETECT_FAKE_TIMERS: 'true', NODE_OPTIONS: '--max_old_space_size=8192' });
    expect(inlined.jest!.flags.maxWorkers).toBe('1');
    expect(isShonoConfigPath('/x/jest.config.js')).toBe(false);
  });

  it('classifies non-jest runners', () => {
    expect(one('node --experimental-strip-types --test */*.test.ts */*/*.test.ts')[0]).toMatchObject({ runner: 'node-test', bin: 'node --test' });
    expect(one('node tests/a.test.js && node tests/b.test.js').map(c => c.runner)).toEqual(['node-test', 'node-test']);
    expect(one('node scripts/test.js')[0]).toMatchObject({ runner: 'other', bin: 'node scripts/test.js' });
    expect(one('mocha "src/**/*.spec.js"')[0].runner).toBe('mocha');
    expect(one('wdio run wdio.conf.ts')[0].runner).toBe('wdio');
    expect(one('detox test -c ios.sim.debug')[0].runner).toBe('detox');
    expect(one('vitest run')[0].runner).toBe('vitest');
    expect(one('yarn workspaces foreach --all run test')[0].runner).toBe('other');
    expect(one(':')[0]).toMatchObject({ runner: 'other', bin: ':' });
  });

  it('follows script references with a cycle guard', () => {
    const infos = sniffScripts({ test: 'yarn test:unit && npm run test:int', 'test:unit': 'jest --testPathIgnorePatterns=int', 'test:int': 'jest -c int.config.js', loop: 'npm run loop' });
    const test = infos.find(i => i.name === 'test')!.commands;
    expect(test.map(c => `${c.script}<-${c.via.join('/')}:${c.jest?.configArg ?? c.jest?.testPathIgnorePatterns.join()}`)).toEqual(['test:unit<-test:int', 'test:int<-test:int.config.js']);
    expect(infos.find(i => i.name === 'loop')!.commands[0]).toMatchObject({ runner: 'other', bin: 'run loop' });
    expect(allCommands(infos).filter(c => c.runner === 'jest')).toHaveLength(4);
  });

  it('ranks script names', () => {
    expect([scriptPriority('test'), scriptPriority('test:js'), scriptPriority('testjs'), scriptPriority('test-js'), scriptPriority('test:unit'), scriptPriority('test:integration'), scriptPriority('test:e2e'), scriptPriority('lint'), scriptPriority('shono:test')]).toEqual([0, 1, 1, 1, 2, 3, 8, 5, 4]);
    expect(isTestLikeScriptName('shono:test')).toBe(true);
    expect(isTestLikeScriptName('build')).toBe(false);
    expect(isE2eScriptName('test:e2e:ios')).toBe(true);
    expect(isE2eScriptName('test')).toBe(false);
    const infos = sniffScripts({ test: 'yarn run shono:test', 'shono:test': 'shono testjs' });
    expect(commandPriority(infos[0].commands[0])).toBe(0);
  });
});
