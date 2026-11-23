/* Unit tests for sync.js — run: node tests/sync.test.js
 * Exercises the op-reduce merge (LWW) and the GitHub-backed store against a
 * mock fetch. No external deps.
 */
'use strict';

const assert = require('assert');
const path = require('path');

// Load sync.js in a fake browser-ish global.
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function loadSync(opts) {
  const listeners = {};
  const g = {
    localStorage: makeStorage(),
    fetch: opts.fetch,
    document: { visibilityState: 'visible', addEventListener() {} },
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const code = require('fs').readFileSync(path.join(__dirname, '..', 'sync.js'), 'utf8');
  const fn = new Function('window', 'self', 'globalThis', 'module', code);
  const sandbox = { localStorage: g.localStorage };
  // Emulate the IIFE's (typeof window !== 'undefined' ? window : this) → window.
  const win = g;
  fn(win, win, win, undefined);
  return win.GrocerySync;
}

/* ---------- 1. reduce() merge semantics ---------- */
function testReduce() {
  const GrocerySync = loadSync({ fetch: async () => { throw new Error('no net'); } });
  const reduce = GrocerySync.reduce;

  // Empty → default single "Grocery" list.
  let doc = reduce([]);
  assert.strictEqual(doc.lists.length, 1);
  assert.strictEqual(doc.lists[0].id, 'main');
  assert.strictEqual(doc.lists[0].items.length, 0);

  // Add an item.
  doc = reduce([
    { id: 'a', ts: 1000, kind: 'item.add', listId: 'main', itemId: 'i1', name: 'Milk' },
  ]);
  assert.strictEqual(doc.lists[0].items.length, 1);
  assert.strictEqual(doc.lists[0].items[0].name, 'Milk');

  // Check it.
  doc = reduce([
    { id: 'a', ts: 1000, kind: 'item.add', listId: 'main', itemId: 'i1', name: 'Milk' },
    { id: 'b', ts: 2000, kind: 'item.check', listId: 'main', itemId: 'i1', checked: true },
  ]);
  assert.strictEqual(doc.lists[0].items[0].checked, true);

  // LWW: older check does not override newer uncheck.
  doc = reduce([
    { id: 'a', ts: 1000, kind: 'item.add', listId: 'main', itemId: 'i1', name: 'Milk' },
    { id: 'c', ts: 3000, kind: 'item.check', listId: 'main', itemId: 'i1', checked: false },
    { id: 'b', ts: 2000, kind: 'item.check', listId: 'main', itemId: 'i1', checked: true },
  ]);
  assert.strictEqual(doc.lists[0].items[0].checked, false, 'newer uncheck wins regardless of order');

  // Edit LWW.
  doc = reduce([
    { id: 'a', ts: 1000, kind: 'item.add', listId: 'main', itemId: 'i1', name: 'Milk' },
    { id: 'e1', ts: 4000, kind: 'item.edit', listId: 'main', itemId: 'i1', name: 'Oat milk', qty: '1L' },
    { id: 'e2', ts: 3000, kind: 'item.edit', listId: 'main', itemId: 'i1', name: 'Wrong' },
  ]);
  assert.strictEqual(doc.lists[0].items[0].name, 'Oat milk');
  assert.strictEqual(doc.lists[0].items[0].qty, '1L');

  // Remove (tombstone) hides item and stays removed across orderings.
  doc = reduce([
    { id: 'a', ts: 1000, kind: 'item.add', listId: 'main', itemId: 'i1', name: 'Milk' },
    { id: 'r', ts: 5000, kind: 'item.remove', listId: 'main', itemId: 'i1' },
  ]);
  assert.strictEqual(doc.lists[0].items.length, 0, 'removed item is hidden');

  // Late re-add of same id after remove must not resurrect (ts older than remove).
  doc = reduce([
    { id: 'r', ts: 5000, kind: 'item.remove', listId: 'main', itemId: 'i1' },
    { id: 'a', ts: 1000, kind: 'item.add', listId: 'main', itemId: 'i1', name: 'Milk' },
  ]);
  // add ran first (ts 1000) creating item, then remove (5000) tombstones it.
  assert.strictEqual(doc.lists[0].items.length, 0, 'older add before remove is overridden');

  // Two lists.
  doc = reduce([
    { id: 'l', ts: 1000, kind: 'list.add', listId: 'produce', name: 'Produce' },
    { id: 'a', ts: 1100, kind: 'item.add', listId: 'produce', itemId: 'p1', name: 'Kale' },
  ]);
  assert.strictEqual(doc.lists.length, 2);
  const produce = doc.lists.find((l) => l.id === 'produce');
  assert.strictEqual(produce.name, 'Produce');
  assert.strictEqual(produce.items[0].name, 'Kale');

  console.log('ok - reduce() merge semantics');
}

/* ---------- 2. store against a mock GitHub API ---------- */
function makeMockGitHub() {
  // In-memory repo: path -> { sha, content(base64 obj) }
  const files = new Map();
  const calls = [];
  function toB64(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64'); }
  function fromB64(s) { return JSON.parse(Buffer.from(s, 'base64').toString('utf8')); }

  const fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const u = new URL(url);
    calls.push({ method, path: u.pathname + u.search, body: options.body });

    if (method === 'GET' && u.pathname === '/repos/me/grocery-data/contents/data/code1.json') {
      const f = files.get('code1');
      if (!f) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return new Response(JSON.stringify({ sha: f.sha, content: f.content }), { status: 200 });
    }
    if (method === 'PUT' && u.pathname === '/repos/me/grocery-data/contents/data/code1.json') {
      const body = JSON.parse(options.body);
      if (body.sha && (!files.has('code1') || files.get('code1').sha !== body.sha)) {
        return new Response(JSON.stringify({ message: 'conflict' }), { status: 409 });
      }
      const sha = 'sha-' + (files.size + 1) + '-' + Date.now();
      files.set('code1', { sha, content: body.content });
      return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'unexpected ' + method + ' ' + u.pathname }), { status: 404 });
  };

  return { fetch, files, calls, toB64, fromB64 };
}

async function testStore() {
  const GrocerySync = loadSync({ fetch: null }); // just to get class
  const mock = makeMockGitHub();

  // We need a store whose fetch is the mock. Re-load with mock fetch.
  const store = loadStoreWith(mock.fetch);

  // createList writes an empty doc.
  await store.createList('t'.repeat(30), 'code1', 'me/grocery-data');
  let doc = store.state();
  assert.strictEqual(doc.lists.length, 1, 'new list has one list');

  // add item
  store.applyOp({ kind: 'item.add', listId: 'main', itemId: 'i1', name: 'Milk' });
  doc = store.state();
  assert.strictEqual(doc.lists[0].items.length, 1);

  // Force a sync (flushTimer is stubbed to no-op, so call directly).
  await store.syncOnce();
  const remote1 = JSON.parse(Buffer.from(mock.files.get('code1').content, 'base64').toString('utf8'));
  assert.ok(remote1.ops.length >= 1, 'ops pushed to remote');

  // Second device joins: loads same file, adds a different item, syncs.
  const store2 = loadStoreWith(mock.fetch);
  await store2.joinList('t'.repeat(30), 'code1', 'me/grocery-data');
  // pull brings remote ops in.
  let doc2 = store2.state();
  const names1 = doc2.lists[0].items.map((i) => i.name);
  assert.ok(names1.includes('Milk'), 'device 2 sees device 1 item after join sync');

  store2.applyOp({ kind: 'item.add', listId: 'main', itemId: 'i2', name: 'Eggs' });
  await store2.syncOnce();

  // Device 1 pulls and sees Eggs.
  await store.syncOnce();
  doc = store.state();
  const names = doc.lists[0].items.map((i) => i.name).sort();
  assert.deepStrictEqual(names, ['Eggs', 'Milk'], 'both items converge');

  // LWW across devices: device1 checks Milk, device2 unchecks stale, merge converges.
  store.applyOp({ kind: 'item.check', listId: 'main', itemId: 'i1', checked: true });
  await store.syncOnce();
  await store2.syncOnce();
  let milk1 = store.state().lists[0].items.find((i) => i.name === 'Milk');
  let milk2 = store2.state().lists[0].items.find((i) => i.name === 'Milk');
  assert.strictEqual(milk1.checked, true, 'check propagated to device1 view');
  assert.strictEqual(milk2.checked, true, 'check propagated to device2 view');

  console.log('ok - store sync/merge against mock GitHub');
  return { store, store2, mock };
}

function loadStoreWith(fetch) {
  const GrocerySync = loadSync({ fetch });
  // window.GrocerySync === createStore factory.
  return GrocerySync({ fetch });
}

/* ---------- run ---------- */
(async () => {
  testReduce();
  await testStore();
  console.log('\nAll tests passed.');
})().catch((e) => {
  console.error('TEST FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});