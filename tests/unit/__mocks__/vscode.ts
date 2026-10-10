// Logic modules (src/core, src/worker) must not import 'vscode'. This mock exists only so a stray
// import fails loudly in tests instead of crashing module resolution.
throw new Error("'vscode' must not be imported by code under test");
