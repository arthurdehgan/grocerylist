/* DOM smoke test: boot app.js in jsdom, exercise the UI end-to-end.
 * Run: node tests/dom.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// Mock GitHub API (in-memory), shared across stores via window.fetch.
function makeMock() {
  const files = new Map();
  const fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    const u = new URL(url);
    const file = u.pathname.match(/data\/([^/]+)\.json$/);
    if (method === 'GET' && file) {
      const f = files.get(file[1]);
      if (!f) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return new Response(JSON.stringify({ sha: f.sha, content: f.content }), { status: 200 });
    }
    if (method === 'PUT' && file) {
      const body = JSON.parse(options.body);
      const sha = 'sha-' + Math.random().toString(36).slice(2);
      files.set(file[1], { sha, content: body.content });
      return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: 'unexpected ' + method + ' ' + u.pathname }), { status: 404 });
  };
  return { fetch, files };
}

(async () => {
  const mock = makeMock();
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Provide localStorage (jsdom has it), fetch, location.reload, confirm.
  window.fetch = mock.fetch;
  window.confirm = () => true;
  // jsdom lacks these; stub as needed.
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });

  // Load sync.js then app.js into the window.
  const runInWindow = (file) => {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    const script = new window.Function(code);
    script.call(window);
  };
  runInWindow('sync.js');
  runInWindow('app.js');

  const { document } = window;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  function touch(type, y, x) {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'touches', {
      value: type === 'touchend' ? [] : [{ clientX: x || 100, clientY: y }],
    });
    return e;
  }

  function pullToRefresh() {
    const wrap = $('#list-wrap');
    wrap.dispatchEvent(touch('touchstart', 100));
    wrap.dispatchEvent(touch('touchmove', 260));
    const label = $('#pull-label').textContent;
    if (label !== 'Release to sync') throw new Error('pull gesture should arm release-to-sync, got: ' + label);
    wrap.dispatchEvent(touch('touchend', 260));
  }

  // ---- setup screen should be visible initially ----
  if (document.querySelector('#setup').hidden) throw new Error('setup screen should be visible on first run');
  if (!document.querySelector('#app').hidden) throw new Error('app should be hidden before pairing');

  // ---- fill setup and create a list ----
  document.querySelector('#token').value = 'ghp_' + 'x'.repeat(36);
  document.querySelector('#repo').value = 'me/grocery-data';
  document.querySelector('#code').value = 'kitchen7';
  document.querySelector('#btn-create').click();

  // doPair is async; wait for microtasks.
  await new Promise((r) => setTimeout(r, 50));

  if (!document.querySelector('#setup').hidden) throw new Error('setup should hide after pairing');
  if (document.querySelector('#app').hidden) throw new Error('app should show after pairing');

  // ---- add an item ----
  const addInput = document.querySelector('#add-input');
  addInput.value = 'Milk';
  document.querySelector('#add-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));

  let rows = $$('#items .item');
  if (rows.length !== 1) throw new Error('expected 1 item after add, got ' + rows.length);
  if (rows[0].querySelector('.name').textContent !== 'Milk') throw new Error('item name mismatch');

  // add a second item
  addInput.value = 'Eggs';
  document.querySelector('#add-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  rows = $$('#items .item');
  if (rows.length !== 2) throw new Error('expected 2 items, got ' + rows.length);

  // alphabetical unchecked: Eggs before Milk
  const names = rows.map((r) => r.querySelector('.name').textContent);
  if (names.join(',') !== 'Eggs,Milk') throw new Error('unchecked sort wrong: ' + names.join(','));

  // ---- check Milk (first item) → should move to bottom ----
  rows[1].querySelector('.check').click(); // Milk
  await new Promise((r) => setTimeout(r, 50));
  rows = $$('#items .item');
  const afterCheck = rows.map((r) => ({
    name: r.querySelector('.name').textContent,
    checked: r.classList.contains('checked'),
  }));
  if (!afterCheck[1].checked || afterCheck[1].name !== 'Milk') {
    throw new Error('checked item should be at bottom: ' + JSON.stringify(afterCheck));
  }
  if (afterCheck[0].name !== 'Eggs' || afterCheck[0].checked) {
    throw new Error('unchecked item should be on top');
  }

  // ---- open detail, edit Milk qty ----
  rows[1].querySelector('.label').click(); // open Milk detail
  await new Promise((r) => setTimeout(r, 20));
  if (document.querySelector('#detail').hidden) throw new Error('detail sheet should open');
  document.querySelector('#edit-qty').value = '2L';
  document.querySelector('#detail-save').click();
  await new Promise((r) => setTimeout(r, 50));

  rows = $$('#items .item');
  const milkRow = rows.find((r) => r.querySelector('.name').textContent === 'Milk');
  const qty = milkRow.querySelector('.qty');
  if (!qty || qty.textContent !== '2L') throw new Error('qty edit not reflected, got: ' + (qty ? qty.textContent : 'none'));

  // ---- uncheck Milk → back to top ----
  milkRow.querySelector('.check').click();
  await new Promise((r) => setTimeout(r, 50));
  rows = $$('#items .item');
  if (rows[0].classList.contains('checked')) throw new Error('Milk should be unchecked/on top');

  // ---- delete Eggs via detail ----
  const eggsRow = rows.find((r) => r.querySelector('.name').textContent === 'Eggs');
  eggsRow.querySelector('.label').click();
  await new Promise((r) => setTimeout(r, 20));
  document.querySelector('#detail-delete').click();
  await new Promise((r) => setTimeout(r, 50));
  rows = $$('#items .item');
  if (rows.length !== 1) throw new Error('expected 1 item after delete, got ' + rows.length);

  // ---- second device joins and sees the list ----
  // Allow device 1's debounced push (400ms) to flush the latest state.
  await new Promise((r) => setTimeout(r, 600));
  const dom2 = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w2 = dom2.window;
  w2.fetch = mock.fetch;
  w2.confirm = () => true;
  const run2 = (f) => { const c = fs.readFileSync(path.join(root, f), 'utf8'); new w2.Function(c).call(w2); };
  run2('sync.js');
  run2('app.js');
  w2.document.querySelector('#token').value = 'ghp_' + 'x'.repeat(36);
  w2.document.querySelector('#repo').value = 'me/grocery-data';
  w2.document.querySelector('#code').value = 'kitchen7';
  // second device uses Join (submit)
  w2.document.querySelector('#setup-form').dispatchEvent(new w2.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 80));

  const rows2 = Array.from(w2.document.querySelectorAll('#items .item'));
  if (rows2.length !== 1) throw new Error('device 2 should see 1 item after sync, got ' + rows2.length);
  if (rows2[0].querySelector('.name').textContent !== 'Milk') throw new Error('device 2 item mismatch');

  // ---- status icon shows syncing while a request is in flight ----
  const liveFetch = window.fetch;
  window.fetch = async function (url, options) {
    const res = await liveFetch(url, options);
    await new Promise((r) => setTimeout(r, 80));
    return res;
  };
  document.querySelector('#sync-status').click();
  await new Promise((r) => setTimeout(r, 20));
  if (!document.querySelector('#sync-status').classList.contains('syncing')) {
    throw new Error('status should show syncing during a request');
  }
  await new Promise((r) => setTimeout(r, 150));
  if (!document.querySelector('#sync-status').classList.contains('ok')) {
    throw new Error('status should return to synced after the request');
  }
  window.fetch = liveFetch;

  // ---- status icon opens a readable error sheet ----
  window.fetch = () => Promise.reject(new Error('network down'));
  document.querySelector('#sync-status').click();
  await new Promise((r) => setTimeout(r, 80));
  if (!document.querySelector('#sync-status').classList.contains('error')) {
    throw new Error('status should show error after a failed sync');
  }
  document.querySelector('#sync-status').click();
  await new Promise((r) => setTimeout(r, 20));
  if (document.querySelector('#sync-sheet').hidden) throw new Error('error status should open the sync sheet');
  if (!document.querySelector('#sync-sheet-message').textContent.includes('network down')) {
    throw new Error('sync sheet should explain the error');
  }
  window.fetch = liveFetch;
  document.querySelector('#sync-sheet-retry').click();
  await new Promise((r) => setTimeout(r, 150));
  if (!document.querySelector('#sync-status').classList.contains('ok')) {
    throw new Error('retry should recover the status');
  }

  // ---- offline edit on device 2, then reconnect sync ----
  // Simulate offline: point fetch to reject.
  const goodFetch = w2.fetch;
  w2.fetch = () => Promise.reject(new Error('offline'));
  const add2 = w2.document.querySelector('#add-input');
  add2.value = 'Bread';
  w2.document.querySelector('#add-form').dispatchEvent(new w2.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  let rows2b = Array.from(w2.document.querySelectorAll('#items .item'));
  if (rows2b.length !== 2) throw new Error('offline add should show locally, got ' + rows2b.length);

  // reconnect
  w2.fetch = goodFetch;
  // trigger a sync by firing the online event the store listens for
  w2.dispatchEvent(new w2.Event('online'));
  await new Promise((r) => setTimeout(r, 300));

  // device 1 pulls and sees Bread
  window.dispatchEvent(new window.Event('online'));
  await new Promise((r) => setTimeout(r, 300));
  const names1 = Array.from(document.querySelectorAll('#items .item .name')).map((n) => n.textContent);
  if (!names1.includes('Bread')) throw new Error('device 1 should receive offline-added Bread, got: ' + names1.join(','));

  // ---- pull-to-refresh pushes a local edit immediately ----
  window.fetch = () => Promise.reject(new Error('offline'));
  addInput.value = 'Apples';
  document.querySelector('#add-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  window.fetch = liveFetch;
  pullToRefresh();
  await new Promise((r) => setTimeout(r, 300));

  w2.dispatchEvent(new w2.Event('online'));
  await new Promise((r) => setTimeout(r, 300));
  const names2 = Array.from(w2.document.querySelectorAll('#items .item .name')).map((n) => n.textContent);
  if (!names2.includes('Apples')) throw new Error('device 2 should receive pull-to-refresh Apples, got: ' + names2.join(','));

  // ---- create a new list via the tabs, add an item to it, switch back ----
  const addListBtn = document.querySelector('#btn-add-list');
  if (!addListBtn) throw new Error('add-list button should be present in the tabs');
  addListBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  if (document.querySelector('#list-sheet').hidden) throw new Error('new-list sheet should open');
  document.querySelector('#new-list-name').value = 'Costco';
  document.querySelector('#list-create').click();
  await new Promise((r) => setTimeout(r, 60));

  const tabNames = $$('#tabs .tab:not(.tab-add)').map((t) => t.textContent);
  if (!tabNames.includes('Costco')) throw new Error('new list should appear as a tab, got: ' + tabNames.join(','));
  if (document.querySelector('#list-title').textContent !== 'Costco') {
    throw new Error('title should switch to the new list');
  }

  const costcoInput = document.querySelector('#add-input');
  costcoInput.value = 'Paper towels';
  document.querySelector('#add-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const costcoItems = $$('#items .item .name').map((n) => n.textContent);
  if (costcoItems.join(',') !== 'Paper towels') {
    throw new Error('new list should hold its own items, got: ' + costcoItems.join(','));
  }

  const groceryTab = $$('#tabs .tab').find((t) => t.textContent === 'Grocery');
  if (!groceryTab) throw new Error('Grocery tab should still exist');
  groceryTab.click();
  await new Promise((r) => setTimeout(r, 40));
  const groceryItems = $$('#items .item .name').map((n) => n.textContent);
  if (!groceryItems.includes('Milk')) throw new Error('Grocery should still contain Milk, got: ' + groceryItems.join(','));
  if (groceryItems.includes('Paper towels')) throw new Error('items must not leak across lists');

  console.log('ok - DOM smoke: boot, add, check->bottom, edit qty, uncheck, delete, 2-device join, offline edit + reconcile, sync status + error sheet, pull-to-refresh, add list + per-list items');
  console.log('\nAll DOM tests passed.');
  process.exit(0);
})().catch((e) => {
  console.error('DOM TEST FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});