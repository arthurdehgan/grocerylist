# Build a signed debug APK for the Grocery PWA WebView shell.
#
# Pipeline: aapt2 (res+manifest) -> add assets & classes.dex manually -> zipalign -> sign.
# Assets are injected by this script (not aapt2) because aapt2 on Windows writes
# backslash separators in the zip, which Android cannot resolve.
#
# Usage: powershell -ExecutionPolicy Bypass -File android\build.ps1

$ErrorActionPreference = "Stop"

$sdk      = "$env:LOCALAPPDATA\Android\Sdk"
$bt       = Join-Path $sdk "build-tools\36.0.0"
$androidJar = Join-Path $sdk "platforms\android-37.0\android.jar"
$root     = Split-Path -Parent $PSScriptRoot
$build    = Join-Path $PSScriptRoot "build"
$assets   = Join-Path $PSScriptRoot "assets"
$res      = Join-Path $PSScriptRoot "res"
$keystore = Join-Path $PSScriptRoot "keystore\grocery.keystore"

foreach ($p in @($bt, $androidJar)) {
    if (! (Test-Path $p)) { throw "Missing Android SDK component: $p" }
}

Write-Host "==> Cleaning build dir"
if (Test-Path $build) { Remove-Item -Recurse -Force $build }
foreach ($d in @("", "\gen", "\classes", "\dex")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $build $d.TrimStart('\')) | Out-Null
}

Write-Host "==> Syncing app assets into android/assets"
if (Test-Path $assets) { Remove-Item -Recurse -Force $assets }
New-Item -ItemType Directory -Force -Path (Join-Path $assets "icons") | Out-Null
foreach ($f in @("index.html","app.js","sync.js","styles.css","manifest.webmanifest","sw.js")) {
    Copy-Item (Join-Path $root $f) (Join-Path $assets $f) -Force
}
Copy-Item (Join-Path $root "icons\*.png") (Join-Path $assets "icons") -Force

Write-Host "==> Compiling resources"
& "$bt\aapt2.exe" compile --dir $res -o (Join-Path $build "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed" }

Write-Host "==> Linking manifest + resources"
& "$bt\aapt2.exe" link `
    -o (Join-Path $build "base.apk") `
    -I $androidJar `
    --manifest (Join-Path $PSScriptRoot "AndroidManifest.xml") `
    --java (Join-Path $build "gen") `
    --min-sdk-version 24 `
    --target-sdk-version 35 `
    (Join-Path $build "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed" }

Write-Host "==> Compiling Java"
$genJava = @(Get-ChildItem -Recurse (Join-Path $build "gen") -Filter *.java | ForEach-Object { $_.FullName })
$mainJava = (Join-Path $PSScriptRoot "src\com\arthurdehgan\grocery\MainActivity.java")
$javacArgs = @('-source','8','-target','8','-bootclasspath',$androidJar,'-classpath',$androidJar,'-d',(Join-Path $build "classes")) + $genJava + @($mainJava)
& javac @javacArgs
if ($LASTEXITCODE -ne 0) { throw "javac failed" }

Write-Host "==> Dexing"
$classes = @(Get-ChildItem -Recurse (Join-Path $build "classes") -Filter *.class | ForEach-Object { $_.FullName })
$d8Args = @('--lib',$androidJar,'--min-api','24','--output',(Join-Path $build "dex")) + $classes
& "$bt\d8.bat" @d8Args
if ($LASTEXITCODE -ne 0) { throw "d8 failed" }

Write-Host "==> Packaging (assets + classes.dex with forward-slash paths)"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$apkPath = Join-Path $build "unsigned.apk"
Copy-Item (Join-Path $build "base.apk") $apkPath -Force

function Add-ZipEntry {
    param($zip, $entryName, $sourcePath)
    $entry = $zip.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    $stream = $entry.Open()
    try {
        $bytes = [System.IO.File]::ReadAllBytes($sourcePath)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally { $stream.Dispose() }
}

$zip = [System.IO.Compression.ZipFile]::Open($apkPath, 'Update')
try {
    foreach ($file in (Get-ChildItem -Recurse $assets -File)) {
        $rel = $file.FullName.Substring($assets.Length + 1).Replace('\', '/')
        Add-ZipEntry $zip "assets/$rel" $file.FullName
    }
    Add-ZipEntry $zip "classes.dex" (Join-Path $build "dex\classes.dex")
} finally { $zip.Dispose() }

Write-Host "==> Zipaligning"
& "$bt\zipalign.exe" -f -p 4 $apkPath (Join-Path $build "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "zipalign failed" }

Write-Host "==> Signing"
if (! (Test-Path $keystore)) { throw "Keystore missing: $keystore" }
& "$bt\apksigner.bat" sign `
    --ks $keystore `
    --ks-pass pass:grocery123 `
    --key-pass pass:grocery123 `
    --ks-key-alias grocery `
    --out (Join-Path $build "grocery.apk") `
    (Join-Path $build "aligned.apk")
if ($LASTEXITCODE -ne 0) { throw "apksigner failed" }

& "$bt\apksigner.bat" verify (Join-Path $build "grocery.apk")
if ($LASTEXITCODE -ne 0) { throw "APK signature verification failed" }

$out = Join-Path $build "grocery.apk"
$size = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host ""
Write-Host "OK  $out  ($size KB)" -ForegroundColor Green