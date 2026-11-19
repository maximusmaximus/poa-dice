#!/usr/bin/env node
/**
 * scripts/check-repo.mjs — Zero-dependency static security, syntax & invariant gate.
 *
 * Checks:
 *  1. Every .mjs / .js file under src/, bin/, public/, scripts/, tests/ passes `node --check`
 *  2. Pinned 0.1% (10 bps) dev reserve address is intact in engine and Python CLI
 *  3. Zero committed secret tokens (pk_*, psk_*, PEM private keys) in source/public/bin
 *  4. Zero inline <script> blocks in public/*.html (strict `script-src 'self'` CSP invariant)
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_DEV = 'poa12XVYtPngbDsm1igG9GPeWPXAHDFTZ1bBLuSwhjqBrQ5U';

function walk(dir, exts, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'data') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, exts, out);
    else if (exts.includes(path.extname(ent.name).toLowerCase())) out.push(full);
  }
  return out;
}

const errors = [];

// 1. JS/MJS syntax check
const jsFiles = [
  ...walk(path.join(ROOT, 'src'), ['.mjs', '.js']),
  ...walk(path.join(ROOT, 'bin'), ['.mjs', '.js']),
  ...walk(path.join(ROOT, 'public'), ['.mjs', '.js']),
  ...walk(path.join(ROOT, 'scripts'), ['.mjs', '.js']),
  ...walk(path.join(ROOT, 'tests'), ['.mjs', '.js'])
];
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    errors.push(`Syntax error in ${path.relative(ROOT, file)}: ${err.stderr?.toString() || err.message}`);
  }
}

// 2. Pinned 0.1% dev reserve check
const engineSrc = fs.readFileSync(path.join(ROOT, 'src', 'bankroll-engine.mjs'), 'utf8');
if (!engineSrc.includes(`export const DEV_RESERVE_ADDRESS = '${PINNED_DEV}';`)) {
  errors.push('DEV_RESERVE_ADDRESS mismatch in src/bankroll-engine.mjs');
}
if (!engineSrc.includes('export const DEV_FEE_BPS = 10n;')) {
  errors.push('DEV_FEE_BPS (10n) mismatch in src/bankroll-engine.mjs');
}
const pyCliSrc = fs.readFileSync(path.join(ROOT, 'bin', 'poa-dice-cli.py'), 'utf8');
if (!pyCliSrc.includes(`DEV_RESERVE_ADDRESS = "${PINNED_DEV}"`)) {
  errors.push('DEV_RESERVE_ADDRESS mismatch in bin/poa-dice-cli.py');
}

// 3. Committed secret scan across production paths
const SECRET_RES = [
  /\bpk_[A-Za-z0-9_-]{16,}\b/,
  /\bpsk_[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN (?:EC |RSA |OPENSSH |)PRIVATE KEY-----/
];
const prodFiles = [
  ...walk(path.join(ROOT, 'src'), ['.mjs', '.js', '.json']),
  ...walk(path.join(ROOT, 'bin'), ['.mjs', '.js', '.py']),
  ...walk(path.join(ROOT, 'public'), ['.html', '.js', '.mjs', '.css', '.txt'])
];
for (const file of prodFiles) {
  const txt = fs.readFileSync(file, 'utf8');
  for (const re of SECRET_RES) {
    if (re.test(txt)) {
      errors.push(`Potential secret matched ${re} in ${path.relative(ROOT, file)}`);
    }
  }
}

// 4. Zero inline <script> blocks in public/*.html (strict CSP invariant)
const htmlFiles = walk(path.join(ROOT, 'public'), ['.html']);
for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  const scriptTags = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const [, attrs, body] of scriptTags) {
    const hasSrc = /\bsrc\s*=/i.test(attrs);
    if (!hasSrc || body.trim().length > 0) {
      errors.push(`Inline <script> violates strict script-src 'self' CSP in ${path.relative(ROOT, file)}`);
    }
  }
}

if (errors.length) {
  console.error('POA Dice static repo check FAILED:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      checkedJsFiles: jsFiles.length,
      checkedHtmlFiles: htmlFiles.length,
      devReserveAddress: PINNED_DEV,
      devFeeBps: 10,
      inlineScripts: 0,
      secretMatches: 0
    },
    null,
    2
  )
);
