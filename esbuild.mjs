import esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Markers VS Code's background problem matcher waits on before launching the dev host. */
const watchReporter = {
  name: 'watch-reporter',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd(result => {
      result.errors.forEach(e => console.error(`✘ [ERROR] ${e.text} (${e.location?.file}:${e.location?.line})`));
      console.log('[watch] build finished');
    });
  },
};

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
  plugins: watch ? [watchReporter] : [],
};

/** The extension host bundle. Only `vscode` is injected by the host. */
const hostBuild = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  target: 'node22',
  external: ['vscode'],
};

/** Project discovery uses a separate thread in the extension host's own Node runtime. */
const discoveryBuild = {
  ...common,
  entryPoints: ['src/discovery/discoveryWorker.ts'],
  outfile: 'dist/discoveryWorker.js',
  target: 'node22',
};

/**
 * Worker-side bundles. They run in the PROJECT's node (not the extension host) and must never
 * bundle Jest/Babel: every Jest package is `require`d through a chain-resolved absolute path at
 * runtime so the project's own versions are used. Only HyperJest code (+ @babel/parser) is inlined.
 */
const workerBuild = {
  ...common,
  entryPoints: {
    hyperjestWorker: 'src/worker/hyperjestWorker.ts',
    reporter: 'src/worker/reporter.ts',
    overlayPreload: 'src/worker/overlayPreload.ts',
  },
  outdir: 'dist/worker',
  outExtension: { '.js': '.cjs' },
  target: 'node18',
};

if (watch) {
  const ctxs = await Promise.all([esbuild.context(hostBuild), esbuild.context(discoveryBuild), esbuild.context(workerBuild)]);
  await Promise.all(ctxs.map(c => c.watch()));
} else {
  await Promise.all([esbuild.build(hostBuild), esbuild.build(discoveryBuild), esbuild.build(workerBuild)]);
}
