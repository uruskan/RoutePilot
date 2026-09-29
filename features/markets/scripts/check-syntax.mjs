#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
async function visit(folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', 'artifacts', '.git'].includes(entry.name)) files.push(...await visit(join(folder, entry.name)));
    else if (entry.isFile() && entry.name.endsWith('.mjs')) files.push(join(folder, entry.name));
  }
  return files;
}
const files = (await visit(root)).sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0 || result.error) {
    console.error(`FAIL ${relative(root, file)}\n${result.stderr || result.error?.message}`); process.exitCode = 1;
  }
}
if (!process.exitCode) console.log(`PASS: Node.js syntax checked ${files.length} ES modules. JSX is checked separately with npm run check:ui.`);
