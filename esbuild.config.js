/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { wasmLoader } from 'esbuild-plugin-wasm';

let esbuild;
try {
  esbuild = (await import('esbuild')).default;
} catch (_error) {
  console.warn('esbuild not available, skipping bundle step');
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const pkg = require(path.resolve(__dirname, 'package.json'));

function createWasmPlugins() {
  const wasmBinaryPlugin = {
    name: 'wasm-binary',
    setup(build) {
      build.onResolve({ filter: /\.wasm\?binary$/ }, (args) => {
        const specifier = args.path.replace(/\?binary$/, '');
        const resolveDir = args.resolveDir || '';
        const isBareSpecifier =
          !path.isAbsolute(specifier) &&
          !specifier.startsWith('./') &&
          !specifier.startsWith('../');

        let resolvedPath;
        if (isBareSpecifier) {
          resolvedPath = require.resolve(specifier, {
            paths: resolveDir ? [resolveDir, __dirname] : [__dirname],
          });
        } else {
          resolvedPath = path.isAbsolute(specifier)
            ? specifier
            : path.join(resolveDir, specifier);
        }

        return { path: resolvedPath, namespace: 'wasm-embedded' };
      });
    },
  };

  return [wasmBinaryPlugin, wasmLoader({ mode: 'embedded' })];
}

const external = [
  '@lydell/node-pty',
  'node-pty',
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-win32-arm64',
  '@lydell/node-pty-win32-x64',
];

const baseConfig = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  external,
  loader: { '.node': 'file' },
  write: true,
};

const cliConfig = {
  ...baseConfig,
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url); globalThis.__filename = require('url').fileURLToPath(import.meta.url); globalThis.__dirname = require('path').dirname(globalThis.__filename);`,
  },
  entryPoints: ['packages/cli/index.ts'],
  outfile: 'bundle/gemini.js',
  define: {
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
  },
  plugins: createWasmPlugins(),
  alias: {
    'is-in-ci': path.resolve(__dirname, 'packages/cli/src/patches/is-in-ci.ts'),
  },
  metafile: true,
};

const cliConfigBinary = {
  ...cliConfig,
  outfile: 'bundle/gemini.mjs',
  minify: true,
};

const cliConfigBun = {
  ...baseConfig,
  format: 'esm', // Required for 'import' syntax in banner
  banner: {
    js: `
      import { createRequire } from 'module';
      import { pathToFileURL, fileURLToPath } from 'url';
      import { dirname } from 'path';

      // 1. Calculate the "real" URL based on the executable path
      // This becomes the source of truth, ignoring the native import.meta.url
      const correctUrl = pathToFileURL(process.execPath).href;

      // 2. Set the global variable that 'define' will use
      globalThis.__exec_path_url = correctUrl;

      // 3. Set standard globals based on this correct path
      globalThis.__filename = process.execPath;
      globalThis.__dirname = dirname(process.execPath);

      // 4. Create a 'require' that resolves relative to the executable path
      const require = createRequire(correctUrl);
    `,
  },
  entryPoints: ['packages/cli/index.ts'],
  outfile: 'bundle/gemini-bun.js',
  define: {
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
    // Replace import.meta.url with the variable we calculated in the banner
    'import.meta.url': 'globalThis.__exec_path_url',
  },
  plugins: createWasmPlugins(),
  alias: {
    'is-in-ci': path.resolve(__dirname, 'packages/cli/src/patches/is-in-ci.ts'),
  },
  metafile: true,
  minify: true,
};

const a2aServerConfig = {
  ...baseConfig,
  banner: {
    js: `const require = (await import('module')).createRequire(import.meta.url); globalThis.__filename = require('url').fileURLToPath(import.meta.url); globalThis.__dirname = require('path').dirname(globalThis.__filename);`,
  },
  entryPoints: ['packages/a2a-server/src/http/server.ts'],
  outfile: 'packages/a2a-server/dist/a2a-server.mjs',
  define: {
    'process.env.CLI_VERSION': JSON.stringify(pkg.version),
  },
  plugins: createWasmPlugins(),
};

Promise.allSettled([
  esbuild.build(cliConfig).then(({ metafile }) => {
    if (process.env.DEV === 'true') {
      writeFileSync('./bundle/esbuild.json', JSON.stringify(metafile, null, 2));
    }
  }),
  esbuild.build(cliConfigBinary),
  esbuild.build(cliConfigBun),
  esbuild.build(a2aServerConfig),
]).then((results) => {
  const [cliResult, cliConfigBinaryResult, cliConfigBunResult, a2aResult] =
    results;
  if (cliResult.status === 'rejected') {
    console.error('gemini.js build failed:', cliResult.reason);
    process.exit(1);
  }
  if (cliConfigBinaryResult.status === 'rejected') {
    console.error('gemini.mjs build failed:', cliConfigBinaryResult.reason);
  }
  if (cliConfigBunResult.status === 'rejected') {
    console.error('gemini.js (Bun) build failed:', cliConfigBunResult.reason);
  }
  // error in a2a-server bundling will not stop gemini.js bundling process
  if (a2aResult.status === 'rejected') {
    console.warn('a2a-server build failed:', a2aResult.reason);
  }
});
