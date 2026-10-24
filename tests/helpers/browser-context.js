// Loads the classic browser scripts (js/*.js) into a Node vm context with just enough
// DOM/browser stubs for their pure logic to run. Top-level declarations become globals of
// the context, exactly like separate <script> tags sharing one page.

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function stubElement() {
  return {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {},
    remove() {},
    addEventListener() {},
    setAttribute() {}
  };
}

function createBrowserContext(overrides = {}) {
  const storage = new Map();
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    performance,
    crypto: globalThis.crypto,
    URL,
    URLSearchParams,
    AbortSignal,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key)
    },
    document: {
      readyState: 'complete',
      head: stubElement(),
      body: stubElement(),
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => stubElement(),
      addEventListener() {}
    },
    navigator: {},
    location: { protocol: 'http:', host: 'localhost', search: '', origin: 'http://localhost', pathname: '/' },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame() {},
    Audio: class { constructor() { this.volume = 1; } play() { return Promise.resolve(); } pause() {} },
    fetch: async () => ({ ok: false, json: async () => [] }),
    innerWidth: 1600,
    innerHeight: 1000,
    ...overrides
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  return ctx;
}

function loadScripts(ctx, files) {
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  }
  return ctx;
}

// Evaluate an expression inside the context (to reach top-level const/class bindings)
function get(ctx, expression) {
  return vm.runInContext(expression, ctx);
}

module.exports = { createBrowserContext, loadScripts, get, ROOT };
