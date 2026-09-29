#!/usr/bin/env node
// Explicit enumeration keeps npm test working in Windows shells without glob expansion.
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const coverage = process.argv.slice(2);
if (coverage.some(value => value !== '--coverage') || coverage.length > 1) {
  console.error('Usage: node scripts/run-tests.mjs [--coverage]'); process.exitCode = 1;
} else {
  const files = (await readdir(join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort();
  if (!files.length) throw new Error('No test files found.');
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap',
    ...(coverage.length ? ['--experimental-test-coverage'] : []), ...files.map(name => join(root, 'test', name))],
  { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
