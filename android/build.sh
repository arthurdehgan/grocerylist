#!/usr/bin/env bash
# Build a signed debug APK for the Grocery PWA WebView shell (macOS/Linux).
#
# Pipeline: aapt2 (res+manifest) -> add assets & classes.dex manually -> zipalign -> sign.
# Assets are injected by this script (not aapt2) because some aapt2 builds write
# backslash separators in the zip, which Android cannot resolve.
#
# Usage: ./android/build.sh
# Requires: Android SDK (build-tools 36, platform android-37), JDK 17+.

set -euo pipefail

sdk="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
bt="$sdk/build-tools/36.0.0"
androidJar="$sdk/platforms/android-37.0/android.jar"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
build="$here/build"
assets="$here/assets"
res="$here/res"
keystore="$here/keystore/grocery.keystore"

for p in "$bt" "$androidJar"; do
    [ -e "$p" ] || { echo "Missing Android SDK component: $p" >&2; exit 1; }
done

echo "==> Cleaning build dir"
rm -rf "$build"
mkdir -p "$build"/{gen,classes,dex}

echo "==> Syncing app assets into android/assets"
rm -rf "$assets"
mkdir -p "$assets/icons"
for f in index.html app.js sync.js styles.css manifest.webmanifest sw.js; do
    cp "$root/$f" "$assets/$f"
done
cp "$root"/icons/*.png "$assets/icons/"

echo "==> Compiling resources"
"$bt/aapt2" compile --dir "$res" -o "$build/res.zip"

echo "==> Linking manifest + resources"
"$bt/aapt2" link \
    -o "$build/base.apk" \
    -I "$androidJar" \
    --manifest "$here/AndroidManifest.xml" \
    --java "$build/gen" \
    --min-sdk-version 24 \
    --target-sdk-version 35 \
    "$build/res.zip"

echo "==> Compiling Java"
mainJava="$here/src/com/arthurdehgan/grocery/MainActivity.java"
javac -source 8 -target 8 \
    -bootclasspath "$androidJar" -classpath "$androidJar" \
    -d "$build/classes" \
    $(find "$build/gen" -name '*.java') "$mainJava"

echo "==> Dexing"
"$bt/d8" --lib "$androidJar" --min-api 24 --output "$build/dex" \
    $(find "$build/classes" -name '*.class')

echo "==> Packaging (assets + classes.dex with forward-slash paths)"
apkPath="$build/unsigned.apk"
cp "$build/base.apk" "$apkPath"

python3 - "$apkPath" "$assets" "$build/dex/classes.dex" <<'PY'
import os, sys, zipfile
apk, assets, dex = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    for dirpath, _dirs, files in os.walk(assets):
        for f in files:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, assets).replace(os.sep, '/')
            z.write(full, "assets/" + rel)
    z.write(dex, "classes.dex")
PY

echo "==> Zipaligning"
"$bt/zipalign" -f -p 4 "$apkPath" "$build/aligned.apk"

echo "==> Signing"
[ -f "$keystore" ] || { echo "Keystore missing: $keystore" >&2; exit 1; }
"$bt/apksigner" sign \
    --ks "$keystore" \
    --ks-pass pass:grocery123 \
    --key-pass pass:grocery123 \
    --ks-key-alias grocery \
    --out "$build/grocery.apk" \
    "$build/aligned.apk"

"$bt/apksigner" verify "$build/grocery.apk"

out="$build/grocery.apk"
size=$(du -k "$out" | cut -f1)
echo
echo "OK  $out  (${size} KB)"