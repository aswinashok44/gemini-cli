/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { globSync } from 'glob';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');

console.log('Build Binary Script Started...');

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

// 3. Generate SEA Blob
console.log('Generating SEA blob...');
try {
  execSync('node --experimental-sea-config sea-config.json', {
    stdio: 'inherit',
    cwd: root,
  });
} catch (e) {
  console.error('Failed to generate SEA blob:', e.message);
  process.exit(1);
}

// Check blob existence. sea-config.json outputs to dist/sea-prep.blob
const blobPath = join(distDir, 'sea-prep.blob');
if (!existsSync(blobPath)) {
  console.error('Error: sea-prep.blob not found in dist/');
  process.exit(1);
}

// 4. Identify Target
const platform = process.platform;
const arch = process.arch;

// Mapping for consistency
const targetName = `${platform}-${arch}`;
console.log(`Targeting: ${targetName}`);

const targetDir = join(distDir, targetName);
mkdirSync(targetDir, { recursive: true });

// 5. Copy Node Binary
const nodeBinary = process.execPath;
const binaryName = platform === 'win32' ? 'gemini.exe' : 'gemini';
const targetBinaryPath = join(targetDir, binaryName);

console.log(`Copying node binary from ${nodeBinary} to ${targetBinaryPath}...`);
copyFileSync(nodeBinary, targetBinaryPath);

// 5.1 Remove Signature
console.log('Removing existing signatures...');
if (platform === 'darwin') {
  try {
    execSync(`codesign --remove-signature "${targetBinaryPath}"`, {
      stdio: 'inherit',
    });
  } catch (e) {
    console.warn(
      'Warning: Failed to remove signature (codesign). This might be fine if not signed.',
      e.message,
    );
  }
} else if (platform === 'win32') {
  // Check for signtool
  let hasSigntool = false;
  try {
    execSync('where signtool', { stdio: 'ignore' });
    hasSigntool = true;
  } catch {
    console.log('Signtool not found. Skipping signature removal.');
  }

  if (hasSigntool) {
    try {
      execSync(`signtool remove /s "${targetBinaryPath}"`, {
        stdio: 'inherit',
      });
    } catch (e) {
      console.warn(
        'Warning: Failed to remove signature (signtool). This might be fine if not signed.',
        e.message,
      );
    }
  }
}

// 6. Copy Assets
console.log('Copying assets...');

// Copy bundle contents
const bundleDir = join(root, 'bundle');
if (existsSync(bundleDir)) {
  cpSync(bundleDir, targetDir, { recursive: true });
}

// Copy node_modules/@lydell
const lydellSrc = join(root, 'node_modules', '@lydell');
const lydellDest = join(targetDir, 'node_modules', '@lydell');
if (existsSync(lydellSrc)) {
  // Ensure parent dir exists
  mkdirSync(join(targetDir, 'node_modules'), { recursive: true });
  cpSync(lydellSrc, lydellDest, { recursive: true });
}

// Remove gemini.js and gemini-bun.js (we use gemini.mjs)
['gemini.js', 'gemini-bun.js'].forEach((file) => {
  const filePath = join(targetDir, file);
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
});

// 7. Inject Blob
console.log('Injecting SEA blob...');
const sentinelFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

try {
  let extraArgs = '';
  if (platform === 'darwin') {
    extraArgs = ' --macho-segment-name NODE_SEA';
  }

  const command = `npx postject "${targetBinaryPath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${sentinelFuse}${extraArgs}`;

  execSync(command, { stdio: 'inherit', cwd: root });
  console.log('Injection successful.');
} catch (e) {
  console.error('Postject failed:', e.message);
  process.exit(1);
}

// 8. Sign Binaries
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

// 9. Cleanup
// Remove sea-prep.blob from dist root
rmSync(blobPath);

console.log(`Binary built successfully in ${targetDir}`);
