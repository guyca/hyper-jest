/** HyperJest's OWN unit tests (not the engine that runs the user's tests). */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/tests/**/*.test.ts'],
  testPathIgnorePatterns: process.env.HYPERJEST_IT ? [] : ['<rootDir>/tests/integration/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json', diagnostics: false, isolatedModules: true }],
  },
  // Logic under src/core and src/worker must never import 'vscode'; tests enforce it by importing them directly.
  moduleNameMapper: { '^vscode$': '<rootDir>/tests/unit/__mocks__/vscode.ts' },
  testTimeout: 20000,
  collectCoverageFrom: ['src/**/*.ts'],
  coverageReporters: ['text', 'html', 'json-summary'],
};
