/* sync.js — op-based store + GitHub Contents API client.
 * Model: the shared document is a list of lists, each with items.
 * Every mutation is an op appended to an append-only log. Current state is
 * derived by folding ops in timestamp order (last-write-wins per field/item).
 * No server: the log is persisted as a JSON file in a private GitHub repo.
 */
(function (global) {
  'use strict';

  const GITHUB_API = 'https://api.github.com';
  const POLL_MS = 20000;

  /* ---------- tiny helpers ---------- */
  function now() { return Date.now(); }
  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function b64utf8Encode(str) {
    return btoa(unescape(encodeURIComponent(str)));
  }
  function b64utf8Decode(b64) {
    return decodeURIComponent(escape(atob(b64.replace(/\s/g, ''))));
  }
  function sanitizeCode(raw) {
    return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 32);
  }
  function validCode(code) {
    return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(code);
  }
  function parseOwnerRepo(str) {
    if (!str) return null;
    const parts = String(str).trim().replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  }

  /* ---------- document model ---------- */
  // A doc: { lists: [{ id, name, items: [{id,name,qty,checked,ts}] }], activeList }
  function emptyDoc() {
    return { lists: [{ id: 'main', name: 'Grocery', items: [] }], activeList: 'main' };
  }
  function findList(doc, listId) {
    return (doc.lists || []).find((l) => l.id === listId) || null;
  }
  function findItem(doc, listId, itemId) {
    const list = findList(doc, listId);
    if (!list) return null;
    return list.items.find((it) => it.id === itemId) || null;
  }

  // Fold a list of ops into a document state.
  function reduce(ops) {
    const doc = emptyDoc();
    const map = new Map(); // listId -> Map(itemId -> item)
    const ordered = ops.slice().sort((a, b) =>
      a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    for (const op of ordered) {
      if (op.kind === 'list.add') {
        if (!findList(doc, op.listId)) {
          doc.lists.push({ id: op.listId, name: op.name || 'List', items: [] });
          map.set(op.listId, new Map());
        }
      } else if (op.kind === 'list.rename') {
        const list = findList(doc, op.listId);
        if (list && op.ts >= (list._ts || 0)) { list.name = op.name; list._ts = op.ts; }
      } else if (op.kind === 'item.add') {
        let list = findList(doc, op.listId);
        if (!list) {
          list = { id: op.listId, name: 'List', items: [] };
          doc.lists.push(list);
        }
        if (!map.has(op.listId)) map.set(op.listId, new Map());
        if (!map.get(op.listId).has(op.itemId) && op.ts >= (list._ts || 0)) {
          const item = { id: op.itemId, name: op.name, qty: op.qty || '', checked: false, ts: op.ts };
          list.items.push(item);
          map.get(op.listId).set(op.itemId, item);
        }
      } else if (op.kind === 'item.edit') {
        const item = findItem(doc, op.listId, op.itemId);
        if (item && op.ts >= (item.ts || 0)) {
          if (op.name != null) item.name = op.name;
          if (op.qty != null) item.qty = op.qty;
          item.ts = op.ts;
        }
      } else if (op.kind === 'item.check') {
        const item = findItem(doc, op.listId, op.itemId);
        if (item && op.ts >= (item.ts || 0)) {
          item.checked = !!op.checked;
          item.ts = op.ts;
        }
      } else if (op.kind === 'item.remove') {
        const item = findItem(doc, op.listId, op.itemId);
        if (item && op.ts >= (item.ts || 0)) {
          item.deleted = true;
          item.ts = op.ts;
        }
      }
    }

    // Drop tombstoned items so they don't linger in the visible list.
    for (const list of doc.lists) {
      list.items = list.items.filter((it) => !it.deleted);
    }
    return doc;
  }

  /* ---------- store ---------- */
  function createStore(opts) {
    opts = opts || {};
    const logKey = opts.logKey || 'grocery.ops';
    const cfgKey = opts.cfgKey || 'grocery.config';
    const fetchImpl = opts.fetch || global.fetch.bind(global);
    const onChange = opts.onChange || function () {};

    let ops = loadJSON(logKey, []);
    let config = loadJSON(cfgKey, null); // { token, code, owner, repo, branch, activeList }
    let remoteSha = null;
    let lastPushedIds = new Set();
    let pollTimer = null;
    let lastError = null;

    function loadJSON(key, fallback) {
      try { return JSON.parse(global.localStorage.getItem(key)) ?? fallback; }
      catch { return fallback; }
    }
    function saveJSON(key, val) {
      global.localStorage.setItem(key, JSON.stringify(val));
    }

    function getConfig() { return config; }
    function saveConfig(patch) {
      config = Object.assign({}, config, patch);
      saveJSON(cfgKey, config);
    }
    function clearConfig() { config = null; saveJSON(cfgKey, null); }

    function state() {
      const doc = reduce(ops);
      if (config && config.activeList && findList(doc, config.activeList)) {
        doc.activeList = config.activeList;
      }
      return doc;
    }

    function setActiveList(listId) { saveConfig({ activeList: listId }); }

    function applyOp(op) {
      op.ts = op.ts || now();
      op.id = op.id || uid();
      ops.push(op);
      saveJSON(logKey, ops);
      onChange(state(), { status: lastError ? 'error' : 'ok' });
      scheduleFlush();
      return op;
    }

    /* ---- GitHub client ---- */
    function ghHeaders() {
      return {
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + config.token,
        'X-GitHub-Api-Version': '2022-11-28',
      };
    }

    async function ghFetch(path, options) {
      const headers = Object.assign(ghHeaders(), (options && options.headers) || {});
      const res = await fetchImpl(GITHUB_API + path, Object.assign({}, options, { headers }));
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        let msg = 'GitHub ' + res.status;
        try { const j = JSON.parse(body); msg = j.message || msg; } catch {}
        if (res.status === 401) msg = 'Invalid token (401)';
        else if (res.status === 403) msg = 'Forbidden (403) — token needs Contents: write, or rate-limited';
        else if (res.status === 404) msg = 'Not found (404) — check owner/repo and token access';
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }

    function repoBase() {
      return '/repos/' + config.owner + '/' + config.repo;
    }
    function filePath() {
      return '/contents/data/' + config.code + '.json';
    }
    function fullFilePath() {
      return repoBase() + filePath() + '?ref=' + encodeURIComponent(config.branch || 'main');
    }

    async function getFile() {
      try {
        return await ghFetch(fullFilePath());
      } catch (e) {
        if (e.status === 404) return null; // not created yet
        throw e;
      }
    }

    function decodeContent(json) {
      if (!json || !json.content) return null;
      return b64utf8Decode(json.content);
    }

    async function putFile(contentObj, sha) {
      const body = {
        message: 'Sync (' + (contentObj.ops ? contentObj.ops.length : 0) + ' ops)',
        content: b64utf8Encode(JSON.stringify(contentObj)),
        branch: config.branch || 'main',
      };
      if (sha) body.sha = sha;
      return ghFetch(repoBase() + filePath(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    /* ---- pull: merge remote ops into local log ---- */
    async function pull() {
      const json = await getFile();
      remoteSha = json ? json.sha : null;
      if (!json || !json.content) return; // remote doc not created yet
      let remote = null;
      try { remote = JSON.parse(decodeContent(json)); } catch { remote = null; }
      if (!remote || !Array.isArray(remote.ops)) return;

      const localIds = new Set(ops.map((o) => o.id));
      let added = 0;
      for (const o of remote.ops) {
        if (!o || !o.id || localIds.has(o.id)) continue;
        ops.push(o);
        localIds.add(o.id);
        // Pulled ops are already on the remote; don't re-push them.
        lastPushedIds.add(o.id);
        added++;
      }
      if (added) {
        saveJSON(logKey, ops);
        onChange(state(), { status: lastError ? 'error' : 'ok' });
      }
    }

    /* ---- push: upload the full (merged) log ---- */
    async function push() {
      // Re-read to get the latest sha (another device may have pushed first).
      const json = await getFile();
      remoteSha = json ? json.sha : null;
      const payload = { version: 1, updatedAt: now(), ops };
      await putFile(payload, remoteSha);
      lastPushedIds = new Set(ops.map((o) => o.id));
    }

    function hasPending() {
      for (const o of ops) if (!lastPushedIds.has(o.id)) return true;
      return false;
    }

    async function syncOnce() {
      if (!config) return;
      try {
        await pull();
        if (hasPending()) {
          try {
            await push();
          } catch (e) {
            // Another device pushed between our read and write (409): merge and retry once.
            if (e.status === 409) {
              await pull();
              if (hasPending()) await push();
            } else {
              throw e;
            }
          }
        }
        lastError = null;
        onChange(state(), { status: 'ok' });
      } catch (e) {
        lastError = e.message || String(e);
        onChange(state(), { status: 'error', error: lastError });
      }
    }

    let flushTimer = null;
    function scheduleFlush() {
      if (!config) return;
      clearTimeout(flushTimer);
      flushTimer = setTimeout(function () { syncOnce(); }, 400);
    }

    function startPolling() {
      stopPolling();
      pollTimer = setInterval(function () { syncOnce(); }, POLL_MS);
      global.addEventListener('online', function () { syncOnce(); });
      global.addEventListener('visibilitychange', function () {
        if (global.document && global.document.visibilityState === 'visible') syncOnce();
      });
    }
    function stopPolling() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }

    /* ---- pairing ---- */
    async function createList(token, code, ownerRepo) {
      code = sanitizeCode(code);
      if (!validCode(code)) throw new Error('Code must be 2–32 letters/digits/hyphens.');
      if (!token || token.length < 20) throw new Error('Paste a valid GitHub token.');
      const or = parseOwnerRepo(ownerRepo);
      if (!or) throw new Error('Enter the private repo as owner/repo, e.g. yourname/grocery-data');
      saveConfig({
        token: token.trim(), code, owner: or.owner, repo: or.repo, branch: 'main', activeList: 'main',
      });
      lastPushedIds = new Set();
      await syncOnce();
      return code;
    }

    async function joinList(token, code, ownerRepo) {
      return createList(token, code, ownerRepo);
    }

    return {
      getConfig, saveConfig, clearConfig, setActiveList,
      state, applyOp,
      createList, joinList,
      pull, push, syncOnce, startPolling, stopPolling,
      get lastError() { return lastError; },
    };
  }

  createStore.reduce = reduce;
  createStore.emptyDoc = emptyDoc;
  createStore.sanitizeCode = sanitizeCode;
  createStore.parseOwnerRepo = parseOwnerRepo;
  global.GrocerySync = createStore;
})(typeof window !== 'undefined' ? window : this);