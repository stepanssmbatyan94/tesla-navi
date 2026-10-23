#!/usr/bin/env node
// Headless runner for the page checks in scripts/verify/checks/.
// Starts its own server, opens each check in a fresh Chrome context and exits non-zero
// if any check's `pass` is false. Works for any agent or human: `npm run verify`.
//
//   npm run verify                      # all checks
//   npm run verify -- smoke maneuvers   # selected checks
//   VERIFY_PORT=8199 CHROME_PATH=/path/to/chrome npm run verify
//
// Uses the system Google Chrome (playwright-core never downloads a browser). Checks hit
// live Yandex/OSRM through the server, so they need network access.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.VERIFY_PORT || 8199);
const BASE = `http://localhost:${PORT}`;
const CHECK_TIMEOUT_MS = 120000;

// Which page each check runs on
const CHECKS = {
  smoke: '/',
  maneuvers: '/',
  'route-layers': '/',
  security: '/',
  phone: '/phone'
};

const requested = process.argv.slice(2).filter(a => !a.startsWith('-'));
const selected = requested.length ? requested : Object.keys(CHECKS);
const unknown = selected.filter(name => !CHECKS[name]);
if (unknown.length) {
  console.error(`Unknown check(s): ${unknown.join(', ')}. Available: ${Object.keys(CHECKS).join(', ')}`);
  process.exit(2);
}

async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (e) {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`Server did not answer on ${url}`);
}

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'pipe']
});
let serverStderr = '';
server.stderr.on('data', d => { serverStderr += d; });

let browser;
let failed = 0;
try {
  await waitForServer(`${BASE}/`);
  browser = await chromium.launch(process.env.CHROME_PATH
    ? { executablePath: process.env.CHROME_PATH, headless: true }
    : { channel: 'chrome', headless: true });

  for (const name of selected) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    const code = `VERIFY${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const started = Date.now();
    let result;
    try {
      await page.goto(`${BASE}${CHECKS[name]}?code=${code}`, { waitUntil: 'load' });
      const script = readFileSync(path.join(ROOT, 'scripts/verify/checks', `${name}.js`), 'utf8');
      result = await Promise.race([
        page.evaluate(script),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS / 1000}s`)), CHECK_TIMEOUT_MS))
      ]);
    } catch (err) {
      result = { pass: false, error: String(err && err.message || err) };
    }
    await context.close();
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (!result || result.pass !== true) failed++;
    console.log(`${result && result.pass === true ? 'PASS' : 'FAIL'}  ${name}  (${seconds}s)`);
    if (!result || result.pass !== true || process.argv.includes('--verbose')) {
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (err) {
  failed++;
  console.error('verify runner error:', err.message);
  if (serverStderr) console.error(serverStderr);
} finally {
  if (browser) await browser.close();
  server.kill();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
