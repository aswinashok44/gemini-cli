// Set an environment variable to signal we are running as a binary
process.env.IS_BINARY = 'true';

// scripts/sea-launch.js
const path = require('node:path');
const m = require('node:module');
const { pathToFileURL } = require('node:url');

// 1. Enable Bytecode Caching (Node v22.8.0+)
// This speeds up subsequent runs of your 10MB bundle significantly.
if (m.enableCompileCache) {
  m.enableCompileCache();
}

// --- 1. ARGUMENT SANITIZATION ---
// Node SEA sets argv[0] and argv[1] to the absolute path of the executable.
// Sometimes, argv[2] contains the relative command used to invoke it (e.g. "./dist/gemini").
// We must detect and remove this "ghost" argument so it isn't parsed as a user command.

if (process.argv.length > 2) {
  const binaryAbs = process.execPath; // The running binary
  const arg2Abs = path.resolve(process.argv[2]); // The 3rd argument resolved

  // If the 3rd argument points to the binary itself, it's a ghost. Remove it.
  if (binaryAbs === arg2Abs) {
    process.argv.splice(2, 1);
  }
}

// supress depreciation warnings for node modules
process.noDeprecation = true;

// 1. Find the sidecar bundle relative to the binary
// process.execPath is the location of the .exe itself
const bundlePath = path.join(path.dirname(process.execPath), 'gemini.mjs');
const bundleUrl = pathToFileURL(bundlePath).href;

// 2. Dynamic Import the ESM bundle
// This works in CJS and allows Top-Level Await inside the target file
import(bundleUrl).catch((err) => {
  console.error('❌ Failed to launch CLI:', err);
  process.exit(1);
});
