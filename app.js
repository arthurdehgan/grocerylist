/* app.js — UI wiring for the shared grocery PWA. */
(function () {
  'use strict';

  const $ = (sel, root) => (root || document).querySelector(sel);

  const els = {
    setup: $('#setup'),
    setupForm: $('#setup-form'),
    token: $('#token'),
    repo: $('#repo'),
    code: $('#code'),
    newCode: $('#new-code'),
    btnCreate: $('#btn-create'),
    setupMsg: $('#setup-msg'),
    app: $('#app'),
    listTitle: $('#list-title'),
    syncStatus: $('#sync-status'),
    syncAnnounce: $('#sync-announce'),
    btnSettings: $('#btn-settings'),
    tabs: $('#tabs'),
    addForm: $('#add-form'),
    addInput: $('#add-input'),
    listWrap: $('#list-wrap'),
    listContent: $('#list-content'),
    pullIndicator: $('#pull-indicator'),
    pullLabel: $('#pull-label'),
    items: $('#items'),
    empty: $('#empty'),
    detail: $('#detail'),
    editName: $('#edit-name'),
    editQty: $('#edit-qty'),
    detailCancel: $('#detail-cancel'),
    detailSave: $('#detail-save'),
    detailDelete: $('#detail-delete'),
    syncSheet: $('#sync-sheet'),
    syncSheetTitle: $('#sync-sheet-title'),
    syncSheetMessage: $('#sync-sheet-message'),
    syncSheetClose: $('#sync-sheet-close'),
    syncSheetRetry: $('#sync-sheet-retry'),
    listSheet: $('#list-sheet'),
    newListName: $('#new-list-name'),
    listCancel: $('#list-cancel'),
    listCreate: $('#list-create'),
    toast: $('#toast'),
  };

  let editing = null; // { listId, itemId }
  let currentDoc = null;
  let toastTimer = null;
  let syncInfo = { status: 'ok', error: '' };
  let pullY = 0;
  let pullTouch = null;
  let refreshing = false;
  let suppressClick = false;
  let suppressTimer = null;
  const PULL_THRESHOLD = 64;
  const MAX_PULL = 96;
  const PULL_HEIGHT = 44;

  /* ---------- store ---------- */
  const store = window.GrocerySync({
    onChange: render,
  });

  /* ---------- boot ---------- */
  function boot() {
    const cfg = store.getConfig();
    if (cfg && cfg.token && cfg.code && cfg.owner && cfg.repo) {
      enterApp();
    } else {
      showSetup();
    }
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
    }
  }

  function showSetup() {
    els.app.hidden = true;
    els.setup.hidden = false;
    const cfg = store.getConfig();
    if (cfg) {
      els.token.value = cfg.token || '';
      els.repo.value = (cfg.owner && cfg.repo) ? cfg.owner + '/' + cfg.repo : '';
      els.code.value = cfg.code || '';
    }
    setTimeout(() => { els.token.focus(); }, 30);
  }

  function enterApp() {
    els.setup.hidden = true;
    els.app.hidden = false;
    currentDoc = store.state();
    render(currentDoc, { status: store.lastError ? 'error' : 'syncing' });
    store.startPolling();
    store.syncOnce();
  }

  /* ---------- setup form ---------- */
  els.newCode.addEventListener('click', () => {
    const words = ['milk', 'eggs', 'bread', 'rice', 'apple', 'beans', 'oats', 'soup', 'fish', 'kale'];
    const w = words[Math.floor(Math.random() * words.length)];
    const n = Math.floor(Math.random() * 90 + 10);
    els.code.value = w + n;
    els.code.focus();
  });

  els.setupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    await doPair(false);
  });
  els.btnCreate.addEventListener('click', async () => { await doPair(true); });

  async function doPair(asCreate) {
    const token = els.token.value.trim();
    const repo = els.repo.value.trim();
    const code = els.code.value.trim();
    els.setupMsg.className = 'msg';
    if (!token || token.length < 20) return setMsg('Paste a valid GitHub token first.', true);
    if (!repo.includes('/')) return setMsg('Enter the private repo as owner/repo.', true);
    if (!code) return setMsg('Enter a pairing code.', true);

    els.setupMsg.textContent = asCreate ? 'Creating…' : 'Joining…';
    els.setupMsg.className = 'msg';
    setBusy(true);
    try {
      if (asCreate) await store.createList(token, code, repo);
      else await store.joinList(token, code, repo);
      enterApp();
      toast(asCreate ? 'List created' : 'Joined list');
    } catch (err) {
      setMsg(err.message || String(err), true);
    } finally {
      setBusy(false);
    }
  }

  function setBusy(b) {
    els.btnCreate.disabled = b;
    $('#btn-join').disabled = b;
    els.newCode.disabled = b;
  }
  function setMsg(text, isErr) {
    els.setupMsg.textContent = text;
    els.setupMsg.className = 'msg' + (isErr ? ' err' : '');
  }

  /* ---------- render ---------- */
  function activeList(doc) {
    return doc.lists.find((l) => l.id === doc.activeList) || doc.lists[0] || null;
  }

  function render(doc, info) {
    currentDoc = doc;
    info = info || { status: 'ok' };
    setSyncStatus(info.status, info.error);

    const list = activeList(doc);
    if (!list) return;
    els.listTitle.textContent = list.name;

    renderTabs(doc);
    renderItems(list);
  }

  function renderTabs(doc) {
    els.tabs.hidden = false;
    els.tabs.innerHTML = '';
    for (const l of doc.lists) {
      const b = document.createElement('button');
      b.className = 'tab' + (l.id === doc.activeList ? ' active' : '');
      b.type = 'button';
      b.textContent = l.name;
      b.addEventListener('click', () => {
        store.setActiveList(l.id);
        render(store.state());
      });
      els.tabs.appendChild(b);
    }
    const add = document.createElement('button');
    add.id = 'btn-add-list';
    add.className = 'tab tab-add';
    add.type = 'button';
    add.title = 'Add list';
    add.setAttribute('aria-label', 'Add list');
    add.textContent = '＋';
    add.addEventListener('click', openListSheet);
    els.tabs.appendChild(add);
  }

  function renderItems(list) {
    const items = list.items.slice();
    // Unchecked first (alpha), then checked at the bottom (most-recently-checked first).
    items.sort((a, b) => {
      if (a.checked !== b.checked) return a.checked ? 1 : -1;
      if (a.checked) return (b.ts || 0) - (a.ts || 0);
      return String(a.name).localeCompare(String(b.name));
    });

    els.items.innerHTML = '';
    els.empty.hidden = items.length > 0;

    for (const item of items) {
      els.items.appendChild(itemRow(list, item));
    }
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function itemRow(list, item) {
    const li = document.createElement('li');
    li.className = 'item' + (item.checked ? ' checked' : '');
    li.dataset.item = item.id;

    const checkbox = document.createElement('button');
    checkbox.type = 'button';
    checkbox.className = 'check';
    checkbox.setAttribute('role', 'checkbox');
    checkbox.setAttribute('aria-checked', String(!!item.checked));
    checkbox.setAttribute('aria-label', item.checked ? 'Uncheck ' + item.name : 'Check ' + item.name);
    checkbox.innerHTML = '<span class="box"></span>';
    checkbox.addEventListener('click', () => {
      toggleCheck(list.id, item);
    });

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'label';
    label.addEventListener('click', () => openDetail(list.id, item));

    const nameWrap = document.createElement('span');
    nameWrap.className = 'name';
    nameWrap.textContent = item.name;
    label.appendChild(nameWrap);
    if (item.qty) {
      const q = document.createElement('span');
      q.className = 'qty';
      q.textContent = item.qty;
      label.appendChild(q);
    }

    li.appendChild(checkbox);
    li.appendChild(label);
    return li;
  }

  /* ---------- mutations ---------- */
  function listId() {
    const list = activeList(currentDoc || store.state());
    return list ? list.id : 'main';
  }

  function toggleCheck(listId, item) {
    store.applyOp({ kind: 'item.check', listId, itemId: item.id, checked: !item.checked });
    if (!item.checked) {
      toast('Bought — moved to bottom');
    }
  }

  els.addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.addInput.value.trim();
    if (!name) return;
    const list = activeList(currentDoc || store.state());
    if (!list) return;
    store.applyOp({ kind: 'item.add', listId: list.id, itemId: uid(), name, qty: '' });
    els.addInput.value = '';
    els.addInput.focus();
    toast('Added ' + name);
  });

  function uid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* ---------- detail sheet ---------- */
  function openDetail(listId, item) {
    editing = { listId, itemId: item.id };
    els.editName.value = item.name;
    els.editQty.value = item.qty || '';
    els.detail.hidden = false;
    setTimeout(() => { els.editName.focus(); els.editName.select(); }, 30);
  }

  function closeDetail() {
    els.detail.hidden = true;
    editing = null;
  }

  els.detailCancel.addEventListener('click', closeDetail);
  els.detail.addEventListener('click', (e) => {
    if (e.target === els.detail) closeDetail();
  });
  els.detailSave.addEventListener('click', () => {
    if (!editing) return;
    const name = els.editName.value.trim();
    if (!name) return;
    store.applyOp({
      kind: 'item.edit', listId: editing.listId, itemId: editing.itemId,
      name, qty: els.editQty.value.trim(),
    });
    closeDetail();
    toast('Saved');
  });
  els.detailDelete.addEventListener('click', () => {
    if (!editing) return;
    store.applyOp({ kind: 'item.remove', listId: editing.listId, itemId: editing.itemId });
    closeDetail();
    toast('Deleted');
  });

  /* ---------- new list sheet ---------- */
  function openListSheet() {
    els.newListName.value = '';
    els.listSheet.hidden = false;
    setTimeout(() => { els.newListName.focus(); }, 30);
  }

  function closeListSheet() {
    els.listSheet.hidden = true;
  }

  function createList() {
    const name = els.newListName.value.trim();
    if (!name) { els.newListName.focus(); return; }
    const listId = 'list-' + uid();
    store.applyOp({ kind: 'list.add', listId, name });
    store.setActiveList(listId);
    closeListSheet();
    render(store.state());
    toast('Created ' + name);
  }

  els.listCancel.addEventListener('click', closeListSheet);
  els.listSheet.addEventListener('click', (e) => {
    if (e.target === els.listSheet) closeListSheet();
  });
  els.listCreate.addEventListener('click', createList);
  els.newListName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); createList(); }
  });

  /* ---------- settings ---------- */
  els.btnSettings.addEventListener('click', () => {
    if (confirm('Disconnect this device from the shared list?')) {
      store.stopPolling();
      store.clearConfig();
      location.reload();
    }
  });

  /* ---------- sync status + toast ---------- */
  function setSyncStatus(status, error) {
    status = status || 'ok';
    error = error || '';
    const changed = syncInfo.status !== status || syncInfo.error !== error;
    syncInfo = { status: status, error: error };

    els.syncStatus.className = 'sync ' + status;
    const label = status === 'syncing' ? 'Syncing…'
      : status === 'offline' ? 'Offline — changes saved on this device'
      : status === 'error' ? 'Sync failed'
      : 'Synced';
    els.syncStatus.setAttribute('aria-label', label);
    els.syncStatus.title = status === 'error' && error ? 'Sync failed: ' + error : label;
    if (changed && els.syncAnnounce) els.syncAnnounce.textContent = label;
    if (!els.syncSheet.hidden) {
      if (status === 'error' || status === 'offline') renderSyncSheet();
      else closeSyncSheet();
    }
  }

  function renderSyncSheet() {
    const offline = syncInfo.status === 'offline';
    els.syncSheetTitle.textContent = offline ? 'You’re offline' : 'Sync problem';
    els.syncSheetMessage.textContent = syncInfo.error ||
      (offline
        ? 'Changes are saved on this device. They will sync when you reconnect.'
        : 'The list could not be synced. Check your connection and token, then try again.');
  }

  function openSyncSheet() {
    renderSyncSheet();
    els.syncSheet.hidden = false;
    setTimeout(function () { els.syncSheetRetry.focus(); }, 30);
  }

  function closeSyncSheet() {
    els.syncSheet.hidden = true;
  }

  els.syncStatus.addEventListener('click', function () {
    if (syncInfo.status === 'error' || syncInfo.status === 'offline') {
      openSyncSheet();
    } else {
      store.syncOnce();
    }
  });

  els.syncSheetClose.addEventListener('click', closeSyncSheet);
  els.syncSheet.addEventListener('click', function (e) {
    if (e.target === els.syncSheet) closeSyncSheet();
  });
  els.syncSheetRetry.addEventListener('click', async function () {
    closeSyncSheet();
    const ok = await store.syncOnce();
    toast(ok ? 'Synced' : 'Sync failed: ' + (store.lastError || 'Please try again'));
  });

  /* ---------- pull to sync ---------- */
  function setPull(px) {
    const y = Math.max(0, Math.min(MAX_PULL, px));
    pullY = y;
    els.listContent.style.transform = y ? 'translateY(' + y + 'px)' : '';
    const indicatorY = Math.max(0, y - PULL_HEIGHT);
    els.pullIndicator.style.transform = 'translateY(' + indicatorY + 'px)';
    els.pullIndicator.style.opacity = String(Math.min(1, y / 48));
  }

  function setPullLabel(text, mode) {
    els.pullLabel.textContent = text;
    els.pullIndicator.classList.remove('idle', 'ready', 'syncing', 'done');
    els.pullIndicator.classList.add(mode || 'idle');
  }

  async function refreshFromPull() {
    if (refreshing) return;
    refreshing = true;
    setPull(PULL_HEIGHT);
    setPullLabel('Syncing…', 'syncing');
    const ok = await store.syncOnce();
    refreshing = false;
    if (ok) {
      setPullLabel('Up to date', 'done');
      setTimeout(function () {
        if (!refreshing && !pullTouch && pullY >= PULL_HEIGHT) {
          setPull(0);
          setPullLabel('Pull to sync', 'idle');
        }
      }, 650);
    } else {
      setPull(0);
      setPullLabel('Pull to sync', 'idle');
      toast('Sync failed: ' + (store.lastError || 'Please try again'));
    }
  }

  function endPull() {
    if (!pullTouch) return;
    const wasActive = pullTouch.active;
    const pull = pullTouch.pull;
    pullTouch = null;
    if (!wasActive) return;

    els.listWrap.classList.remove('dragging');
    if (pull > 8) {
      suppressClick = true;
      clearTimeout(suppressTimer);
      suppressTimer = setTimeout(function () { suppressClick = false; }, 400);
    }
    if (pull >= PULL_THRESHOLD && !refreshing) {
      refreshFromPull();
    } else {
      setPull(0);
      setPullLabel('Pull to sync', 'idle');
    }
  }

  els.listWrap.addEventListener('touchstart', function (e) {
    if (refreshing || !els.detail.hidden || e.touches.length !== 1) return;
    if (els.listWrap.scrollTop > 0) return;
    const t = e.touches[0];
    pullTouch = { startX: t.clientX, startY: t.clientY, active: false, pull: 0 };
  }, { passive: true });

  els.listWrap.addEventListener('touchmove', function (e) {
    if (!pullTouch || refreshing) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    const dy = t.clientY - pullTouch.startY;
    const dx = t.clientX - pullTouch.startX;

    if (!pullTouch.active) {
      if (dy <= 0) return;
      if (Math.abs(dx) > Math.abs(dy)) { pullTouch = null; return; }
      if (els.listWrap.scrollTop > 0) { pullTouch = null; return; }
      pullTouch.active = true;
      els.listWrap.classList.add('dragging');
    }

    if (dy <= 0) {
      pullTouch.pull = 0;
      setPull(0);
      setPullLabel('Pull to sync', 'idle');
      return;
    }

    if (e.cancelable) e.preventDefault();
    const y = Math.min(MAX_PULL, dy * 0.55);
    pullTouch.pull = y;
    setPull(y);
    setPullLabel(y >= PULL_THRESHOLD ? 'Release to sync' : 'Pull to sync',
      y >= PULL_THRESHOLD ? 'ready' : 'idle');
  }, { passive: false });

  els.listWrap.addEventListener('touchend', endPull);
  els.listWrap.addEventListener('touchcancel', endPull);

  els.listWrap.addEventListener('click', function (e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove('show');
      setTimeout(() => { els.toast.hidden = true; }, 250);
    }, 1800);
  }

  boot();
})();