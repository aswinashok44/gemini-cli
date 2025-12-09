/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { rmSync, mkdirSync, existsSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { globSync } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');

console.log('Build Bun Binary Script Started...');

// 1. Clean dist
if (existsSync(distDir)) {
  console.log('Cleaning dist directory...');
  rmSync(distDir, { recursive: true, force: true });
}
mkdirSync(distDir);

// 2. Build Bundle
console.log('Running npm clean, install, and bundle...');
try {
  execSync('npm run clean', { stdio: 'inherit', cwd: root });
  execSync('npm install', { stdio: 'inherit', cwd: root });
  execSync('npm run bundle', { stdio: 'inherit', cwd: root });
} catch (e) {
  console.error('Build step failed:', e.message);
  process.exit(1);
}

// 3. Identify Target
const platform = process.env.TARGET_PLATFORM || process.platform;
const arch = process.env.TARGET_ARCH || process.arch;

// Map to Bun targets
const bunPlatform = platform === 'win32' ? 'windows' : platform;
const bunTarget = `bun-${bunPlatform}-${arch}`;
console.log(`Targeting: ${bunTarget}`);

const targetDir = join(distDir, `${platform}-${arch}`);
mkdirSync(targetDir, { recursive: true });

const binaryName = platform === 'win32' ? 'gemini.exe' : 'gemini';
const targetBinaryPath = join(targetDir, binaryName);
const entryPoint = join(root, 'bundle', 'gemini-bun.js');

// 4. Compile with Bun
console.log('Compiling with Bun...');
try {
  // Check if bun is available
  execSync('bun --version', { stdio: 'ignore' });

  const cmd = `bun build --compile --target ${bunTarget} "${entryPoint}" --outfile "${targetBinaryPath}"`;
  console.log(`Running: ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root });
} catch (e) {
  console.error(
    'Bun compilation failed. Ensure Bun is installed and available in PATH.',
    e.message,
  );
  process.exit(1);
}

// 5. Copy Assets
console.log('Copying assets...');

// Copy bundle contents (excluding gemini.js which is compiled, but we copy all then remove)
const bundleDir = join(root, 'bundle');
if (existsSync(bundleDir)) {
  cpSync(bundleDir, targetDir, { recursive: true });
}

// Remove source JS files from target (they are inside the binary now)
['gemini.js', 'gemini.mjs', 'gemini-bun.js'].forEach((file) => {
  const filePath = join(targetDir, file);
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
});

// Note: node_modules copying is skipped for Bun as requested.

// 6. Sign Binaries
console.log('Signing binaries...');
try {
  if (platform === 'darwin') {
    const identity = process.env.APPLE_IDENTITY || '-';
    console.log(`Signing with identity: ${identity}`);

    // Sign .node files first
    const nodeFiles = globSync('**/*.node', { cwd: targetDir, absolute: true });
    for (const file of nodeFiles) {
      console.log(`Signing ${file}...`);
      execSync(
        `codesign --sign "${identity}" --force --timestamp --options runtime "${file}"`,
        { stdio: 'inherit' },
      );
    }

    // Sign main binary
    console.log(`Signing ${targetBinaryPath}...`);
    execSync(
      `codesign --sign "${identity}" --force --timestamp --options runtime "${targetBinaryPath}"`,
      { stdio: 'inherit' },
    );
  } else if (platform === 'win32') {
    // Default signtool command (can be overridden)
    // Assumes certificates are in the store or env vars provided for a custom command
    const signCmd =
      process.env.SIGN_CMD_WIN ||
      'signtool sign /a /fd SHA256 /td SHA256 /tr http://timestamp.digicert.com';
    console.log(`Signing with command: ${signCmd}`);

    // Sign .node files first
    const nodeFiles = globSync('**/*.node', { cwd: targetDir, absolute: true });
    for (const file of nodeFiles) {
      console.log(`Signing ${file}...`);
      execSync(`${signCmd} "${file}"`, { stdio: 'inherit' });
    }

    // Sign main binary
    console.log(`Signing ${targetBinaryPath}...`);
    execSync(`${signCmd} "${targetBinaryPath}"`, { stdio: 'inherit' });
  } else {
    console.log('Skipping signing for platform:', platform);
  }
} catch (e) {
  console.warn('Signing failed:', e.message);
  console.warn('Continuing without signing...');
}

console.log(`Bun binary built successfully in ${targetDir}`);
