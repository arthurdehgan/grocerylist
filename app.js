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
    btnSettings: $('#btn-settings'),
    tabs: $('#tabs'),
    addForm: $('#add-form'),
    addInput: $('#add-input'),
    items: $('#items'),
    empty: $('#empty'),
    detail: $('#detail'),
    editName: $('#edit-name'),
    editQty: $('#edit-qty'),
    detailCancel: $('#detail-cancel'),
    detailSave: $('#detail-save'),
    detailDelete: $('#detail-delete'),
    toast: $('#toast'),
  };

  let editing = null; // { listId, itemId }
  let currentDoc = null;
  let toastTimer = null;

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
    render(currentDoc, { status: store.lastError ? 'error' : 'ok' });
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
    if (!doc.lists || doc.lists.length <= 1) {
      els.tabs.hidden = true;
      els.tabs.innerHTML = '';
      return;
    }
    els.tabs.hidden = false;
    els.tabs.innerHTML = '';
    for (const l of doc.lists) {
      const b = document.createElement('button');
      b.className = 'tab' + (l.id === doc.activeList ? ' active' : '');
      b.textContent = l.name;
      b.addEventListener('click', () => {
        store.setActiveList(l.id);
        render(store.state());
      });
      els.tabs.appendChild(b);
    }
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
    if (status === 'error') {
      els.syncStatus.className = 'sync err';
      els.syncStatus.textContent = '⚠';
      els.syncStatus.title = error || 'Sync error';
    } else {
      els.syncStatus.className = 'sync ok';
      els.syncStatus.textContent = '●';
      els.syncStatus.title = 'Synced';
    }
  }

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