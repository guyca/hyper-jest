/**
 * Jest transform for HyperJest's own unit tests.
 *
 * TypeScript 7 ships a native `tsc` without the JavaScript compiler API that ts-jest
 * requires. This transform:
 *  1. Compiles TypeScript / ESM-to-CJS with esbuild (already a project dependency)
 *  2. Runs `babel-plugin-jest-hoist` on the CJS output so `jest.mock` stays above requires
 *     (esbuild would otherwise hoist `import`/`require` above `jest.mock`)
 *
 * Also used (via transformIgnorePatterns) to load Babel 8's ESM-only packages under Jest.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const babel = require('@babel/core');

function loaderFor(sourcePath) {
  if (sourcePath.endsWith('.tsx')) return 'tsx';
  if (sourcePath.endsWith('.ts')) return 'ts';
  if (sourcePath.endsWith('.mjs')) return 'js';
  return 'js';
}

function hoistJestMocks(compiled, sourcePath) {
  // Only hoist test files that call jest.mock* — skip node_modules ESM shims.
  if (!sourcePath.includes(`${path.sep}tests${path.sep}`) || !/\bjest\.(mock|unmock|deepUnmock|doMock|dontMock)\s*\(/.test(compiled.code)) {
    return { code: compiled.code, map: compiled.map };
  }
  const result = babel.transformSync(compiled.code, {
    filename: sourcePath.endsWith('.ts') || sourcePath.endsWith('.tsx')
      ? sourcePath.replace(/\.tsx?$/, '.js')
      : sourcePath,
    babelrc: false,
    configFile: false,
    inputSourceMap: JSON.parse(compiled.map),
    sourceMaps: true,
    plugins: [require.resolve('babel-plugin-jest-hoist')],
  });
  return { code: result?.code ?? compiled.code, map: result?.map ?? compiled.map };
}

module.exports = {
  process(sourceText, sourcePath) {
    const compiled = esbuild.transformSync(sourceText, {
      loader: loaderFor(sourcePath),
      format: 'cjs',
      target: 'node22',
      // Jest executes CommonJS in a VM without native import() support.
      supported: { 'dynamic-import': false },
      // Babel composes this map when hoisting mocks so stack traces and coverage
      // still point at the original TypeScript source.
      sourcemap: 'external',
      sourcefile: sourcePath,
    });
    return hoistJestMocks(compiled, sourcePath);
  },
  getCacheKey(sourceText, sourcePath) {
    return crypto.createHash('sha1')
      .update(sourceText)
      .update('\0')
      .update(sourcePath)
      .update('\0')
      .update(fs.readFileSync(__filename))
      .digest('hex');
  },
};
