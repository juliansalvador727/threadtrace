import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const integration = process.argv.includes('--integration');

// Prints markers that .vscode/tasks.json uses to know when a watch build is done.
const watchLogger = (name) => ({
  name: 'watch-logger',
  setup(build) {
    build.onStart(() => console.log(`[watch] ${name} build started`));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log(`[watch] ${name} build finished`);
    });
  },
});

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

/** The extension host bundle. `vscode` is provided by VS Code at runtime. */
const extension = {
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  target: 'node20',
  external: ['vscode'],
  plugins: watch ? [watchLogger('extension')] : [],
};

/**
 * The standalone hook script. `vscode` is deliberately NOT external here, so
 * an import of it anywhere under src/capture/ fails the build.
 */
const capture = {
  ...common,
  entryPoints: ['src/capture/tt-capture.ts'],
  outfile: 'dist/tt-capture.js',
  target: 'node18',
  plugins: watch ? [watchLogger('tt-capture')] : [],
};

/** Integration tests, run by mocha inside the Extension Development Host. */
const integrationTests = {
  ...common,
  minify: false,
  sourcemap: true,
  entryPoints: [
    'test/integration/runTest.ts',
    'test/integration/suite/index.ts',
    'test/integration/suite/activate.test.ts',
  ],
  outdir: 'out/test/integration',
  outbase: 'test/integration',
  target: 'node20',
  external: ['vscode', 'mocha', '@vscode/test-electron'],
};

if (integration) {
  await esbuild.build(integrationTests);
} else if (watch) {
  const contexts = await Promise.all([esbuild.context(extension), esbuild.context(capture)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(capture)]);
}
