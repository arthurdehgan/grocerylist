# AGENTS.md

Shared grocery list PWA. Two "backendless" parts: a static web app and an Android
WebView shell. There is **no bundler, framework, lint, or typecheck** — plain
HTML/CSS/JS served as-is. `README.md` is the human-facing overview; this file is the
agent quick-start.

## Commands

```sh
npm install      # only dep is jsdom (test-only)
npm test         # sync unit tests + DOM smoke tests
npm run test:sync
npm run test:dom
npm run serve    # python -m http.server 8080 (PWA needs localhost or https, not file://)
```

- No lint/format/typecheck step exists — don't hunt for one.
- Tests are standalone scripts with no name filter; a "focused" run means running one file
  (`node tests/sync.test.js` or `node tests/dom.test.js`). Both exit non-zero on failure.

## Architecture

- `sync.js` — the model. Exposes `window.GrocerySync(opts)` (a store factory) plus statics
  `reduce`, `emptyDoc`, `sanitizeCode`, `parseOwnerRepo`. Persists to `localStorage`, syncs
  via the GitHub Contents API to `data/<code>.json` in a private repo.
- `app.js` — DOM wiring/render only (IIFE). No state beyond the current doc + UI flags.
- `index.html` / `styles.css` / `sw.js` / `manifest.webmanifest` — shell, styles, offline cache.
- `tests/` — `sync.test.js` (op reduce/LWW + two-device sync vs. mock fetch) and
  `dom.test.js` (boots the real `app.js`/`sync.js` in jsdom with `runScripts:
  'outside-only'`, mock GitHub, no network).
- `android/` — thin WebView shell. `android/assets/` and `android/build/` are **generated
  and gitignored**; the source of truth for app assets is the repo root.

## Model invariants (easy to break silently)

- Every mutation is an **append-only op** `{id, ts, kind, listId, itemId, ...}`. Current
  state is derived only by `reduce(ops)` in `sync.js`. Never mutate a "current state" object
  as if it were the source of truth.
- Adding a new op kind means handling it in `reduce()` **and** covering it in
  `tests/sync.test.js`. Merge is last-write-wins on `ts`, so ops must carry a sane `ts`.
- `item.ts` is the LWW timestamp and changes on every edit/check/remove. `item.created` is
  set once at add time and must stay stable — item ordering depends on it.
- Deletions are tombstones (`item.remove` sets `deleted`); `reduce()` filters them out at the
  end. A late-arriving older op must not resurrect a removed item.
- The active list lives in **config** (`activeList` in `localStorage`), not in the document.
  `state()` overlays it onto the reduced doc.
- `sw.js` caches the app shell **cache-first**. After changing any shell asset
  (`index.html`, `app.js`, `styles.css`, `sync.js`, icons), bump `CACHE` (`grocery-v2` →
  `grocery-v3`) or the WebView/PWA will keep serving the stale cached bundle.

## Android shell

- APKs are built on both **Windows and macOS**. On Windows use `android/build.ps1`; on macOS
  there is no PowerShell, so drive the same pipeline manually.
- `android/build.ps1` is **PowerShell and Windows-only** (uses `.exe`/`.bat`, `%LOCALAPPDATA%`).
  On macOS/Linux you must drive the same pipeline manually:
  `aapt2 compile` → `aapt2 link` → `javac` → `d8` → add `assets/` + `classes.dex` to the
  apk → `zipalign` → `apksigner`. SDK pieces used: build-tools `36.0.0`, platform
  `android-37.0`, JDK 17. The keystore (alias/passwords) is configured in `build.ps1`.
- The script re-copies the root web files into `android/assets/` at build time, so **web
  changes need a rebuild + reinstall** to reach the APK (`adb install -r android/build/grocery.apk`).
- `android/keystore/` and `android/build/` are gitignored; losing the keystore means
  uninstall/reinstall (Android rejects updates signed with a different key).

## Verify

- After any change, decide whether an APK rebuild is necessary and **say so explicitly**. A
  rebuild is necessary if the change touched shell assets (`index.html`, `app.js`,
  `styles.css`, `sync.js`, `sw.js`, `manifest.webmanifest`, icons) or anything under `android/`.
  State whether the user must reinstall the APK on their phone to get the change, or whether it
  will arrive OTA (localStorage / GitHub Contents sync — no APK needed).
- If a rebuild is necessary, build it (macOS: drive the manual pipeline above), then:
  - If a phone is connected (`adb devices`), suggest installing with
    `adb install -r android/build/grocery.apk`.
  - If no phone is connected, prompt the user to connect one via `adb` and confirm with
    `adb devices`.
- After a successful `adb install`, also copy the APK to the phone's Download folder, replacing
  any previously existing `grocery.apk`:
  `adb push android/build/grocery.apk /sdcard/Download/grocery.apk`

## Conventions

- Commit only when explicitly asked, and show the exact message for approval first.
- UI assertions in `dom.test.js` encode ordering and element ids; changing sort order or DOM
  ids usually requires updating that test in the same change.