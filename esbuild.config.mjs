import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const isDev = process.argv.includes('--watch');

const commonConfig = {
  bundle: true,
  minify: !isDev,
  treeShaking: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': isDev ? '"development"' : '"production"' },
  drop: isDev ? [] : ['console', 'debugger'],
  external: ['node:crypto', 'node:http', 'node:fs', 'node:path', 'node:url'],
};

// 1. Server Build (Node.js)
const serverConfig = {
  ...commonConfig,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  platform: 'node',
  format: 'esm',
  target: 'node18',
};

// 2. Worker Build (Cloudflare Workers / Neutral)
const workerConfig = {
  ...commonConfig,
  entryPoints: ['src/worker.ts'],
  outfile: 'dist/worker.js',
  platform: 'neutral',
  format: 'esm',
  target: 'es2022',
  mangleProps: /_$/,
};

// 3. Client Build (Browser)
const clientConfig = {
  ...commonConfig,
  entryPoints: ['src/client.ts'],
  outfile: 'dist/public/client.js',
  platform: 'browser',
  target: 'es2022',
  mangleProps: /_$/,
};

async function build() {
  // Ensure dist structure
  if (!fs.existsSync('dist/public')) {
    fs.mkdirSync('dist/public', { recursive: true });
  }

  // Copy index.html
  fs.copyFileSync('public/index.html', 'dist/public/index.html');

  if (isDev) {
    console.log('Watching for changes...');
    const contexts = await Promise.all([
      esbuild.context(serverConfig),
      esbuild.context(workerConfig),
      esbuild.context(clientConfig),
    ]);
    await Promise.all(contexts.map(ctx => ctx.watch()));
  } else {
    console.log('Building for production...');
    await Promise.all([
      esbuild.build(serverConfig),
      esbuild.build(workerConfig),
      esbuild.build(clientConfig),
    ]);
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
