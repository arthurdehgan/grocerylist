# GroceryList — shared grocery PWA for two people

An installable **Progressive Web App** (Android: "Add to home screen") that keeps one
grocery list in sync between two phones with **no hosting bill**. The "database" is a
JSON file in a **private GitHub repo**; each device talks to the GitHub REST API with a
fine-grained token. Edits merge per item (last-write-wins), so offline changes made on
one phone reconcile with the other on reconnect.

## Why these choices

| Requirement | Decision |
| --- | --- |
| Android-only app | Installable PWA — one codebase, full-screen, offline, instant updates over the air. No APK sideload. |
| Free hosting | Static assets on **GitHub Pages**; data stored as a file in the repo via the GitHub API. |
| Two users | A short **pairing code** (the file name). No accounts, no passwords. |
| Edit from anywhere | Any device that loads the PWA and has the pairing code + token can read/write. |
| Check → bottom | Unchecked items sort above checked ones; checking animates an item to the bottom. |
| Future multiple lists/tabs | The model is already a list of lists; the UI renders tabs per list. |

## How sync works (no server)

```
Phone A (offline)                GitHub repo                  Phone B (online)
---------------                ------------                 ----------------
user taps "check"      --- op --->  data/grocery-<code>.json  <--- poll every 20s ---
op saved locally                 (single source of truth)          apply op
replays on reconnect                   ▲                              show item checked
                                       └── both phones merge ops, LWW per item
```

- Every change is an **op** `{id, ts, kind, listId, itemId, ...}` stored in an
  append-only log. A device keeps its own ops in `localStorage` and flushes them to
  the repo on reconnect; it also pulls the remote log and merges.
- Because each item's current state is derived by folding ops in `ts` order, two
  devices editing the same item converge deterministically (last timestamp wins).
- Removals are tombstones (an op), so a deleted item doesn't reappear from the other
  phone's cached copy.

## Setup

### 1. Create a private repo and a token (once)
1. Create a **private** GitHub repository, e.g. `grocery-data`.
2. Create a **fine-grained** token: GitHub → Settings → Developer settings →
   Personal access tokens → Fine-grained tokens → Generate new.
   - Repository access: **Only select repositories** → the repo above.
   - Permissions: **Contents → Read and write** (nothing else).
3. Copy the token (starts with `github_pat_…`).

### 2. Deploy the PWA (free)
1. Push this folder to a **public** repo, e.g. `grocery-app`.
2. In that repo: Settings → Pages → *Build and deployment* → **Source: Deploy from a
   branch**, branch `main`, folder `/ (root)`. Save.
3. The app is served at `https://<user>.github.io/grocery-app/`.
   (The app code is public; the *data* stays in your private repo, unlocked by the token.)

### 3. Pair both phones
1. Open the Pages URL on each phone → "Add to home screen" → install.
2. On **Phone A**: enter your token, type a new pairing code (e.g. `kitchen7`), tap
   **Create list**. This writes `data/grocery-kitchen7.json` in the private repo.
3. On **Phone B**: enter the **same** token and the same code `kitchen7`, tap **Join**.
4. Both phones now share one list. Edits sync automatically (~20s + on reconnect).

> The pairing code lives in the file name, so anyone with the code **and** a valid
> token can edit. Keep both private. The token is stored only in that device's
> browser storage.

## Development

Zero build step. Serve the folder over HTTP (PWA features need `http://localhost` or
HTTPS, not `file://`):

```sh
python -m http.server 8080
# open http://localhost:8080
```

### Tests
```sh
npm install        # installs jsdom (test-only dependency)
npm test           # runs sync unit tests + DOM smoke tests
```

- `tests/sync.test.js` — exercises the op-reduce/LWW merge and a two-device sync
  against a mock GitHub API (no network).
- `tests/dom.test.js` — boots the real `app.js` in a headless DOM and drives the UI:
  add, check→bottom, edit qty, uncheck, delete, two-device join, and an offline edit
  that reconciles on reconnect.

## Project layout
```
index.html            App shell (setup screen + list screen)
styles.css            Styling (mobile-first, safe-area aware)
app.js                UI wiring + rendering
sync.js               Op model, LWW reduce, GitHub Contents API client
manifest.webmanifest  PWA manifest (installable)
sw.js                 Offline app-shell cache
icons/                Generated PWA icons (192/512/maskable)
tools/make_icons.py   Icon generator (pure-Python PNG writer)
tests/                Unit + DOM tests (jsdom)
```

## Multiple lists (roadmap)

The data file already holds `lists: [{id, name, items: []}]`. Adding a tab bar that
switches the active `listId` is the only UI work; sync and merge are unaffected.

## Security notes
- The fine-grained token is scoped to one private repo with only Contents:RW. It cannot
  touch anything else.
- Data at rest is an opaque JSON blob in your private repo; GitHub is the datastore.
- No analytics, no third-party requests at runtime except `api.github.com`.