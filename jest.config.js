/** HyperJest's OWN unit tests (not the engine that runs the user's tests). */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: process.env.HYPERJEST_IT ? [] : ['<rootDir>/tests/integration/'],
  transform: {
    // TypeScript 7 has no JS compiler API for ts-jest; transform with esbuild (+ jest-hoist).
    '^.+\\.[cm]?[jt]sx?$': '<rootDir>/tests/jest-esbuild-transform.cjs',
  },
  // Babel 8 ships ESM-only packages; compile them to CJS for Jest's runtime.
  transformIgnorePatterns: [
    '/node_modules/(?!@babel/(?:parser|types|helper-string-parser)(?:/|$))',
  ],
  // Logic under src/core and src/worker must never import 'vscode'; tests enforce it by importing them directly.
  moduleNameMapper: { '^vscode$': '<rootDir>/tests/unit/__mocks__/vscode.ts' },
  testTimeout: 20000,
  collectCoverageFrom: ['src/**/*.ts'],
  coverageReporters: ['text', 'html', 'json-summary'],
};
