#!/usr/bin/env node
// Development-only check. No TypeScript/React dependency is needed by the backend or node:test suite.
// Supply TypeScript via your existing frontend dev environment or:
// npm install --no-save --package-lock=false typescript@5.8.3
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
let ts;
try { ts = require('typescript'); }
catch { console.error('TypeScript is not installed. This optional JSX syntax check needs TypeScript; see docs/TESTING.md.'); process.exitCode = 1; }
if (ts) {
  const path = fileURLToPath(new URL('../ui/MarketPanel.jsx', import.meta.url));
  const source = await readFile(path, 'utf8');
  const output = ts.transpileModule(source, { fileName: path, reportDiagnostics: true, compilerOptions: {
    allowJs: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.ReactJSX, isolatedModules: true,
  } });
  const errors = (output.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n',
    })); process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: output.outputText, encoding: 'utf8', windowsHide: true,
    });
    if (result.status !== 0 || result.error) { console.error(result.stderr || result.error?.message); process.exitCode = 1; }
    else console.log(`PASS: MarketPanel.jsx transpiles with TypeScript ${ts.version}; emitted ES-module JavaScript passes Node syntax checking. This is not a browser render test.`);
  }
}
