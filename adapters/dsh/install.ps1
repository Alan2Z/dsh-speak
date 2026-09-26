# install.ps1 — one-command installer for the DSH adapter
# ========================================================
# 1. copies engine/*.ps1 to ~/.dsh/hooks/
# 2. copies speech-hook.js to ~/.dsh/profiles/web/plugins/
# 3. registers the plugin in ~/.dsh/profiles/web/cordis.patch.yml (backs it up first)
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1 -DshHome C:\Users\you\.dsh -PluginsDir C:\Users\you\.dsh\profiles\web\plugins
#
# After installing, restart the DSH web app (the profile tree is composed at boot).

param(
    [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
    [string]$EngineDir = '',
    [string]$PluginsDir = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..')

if (-not $EngineDir) { $EngineDir = Join-Path $DshHome 'hooks' }
if (-not $PluginsDir) { $PluginsDir = Join-Path $DshHome 'profiles\web\plugins' }
$cordisPatch = Join-Path $DshHome 'profiles\web\cordis.patch.yml'

# ---------- 1. engine ----------
Write-Host "==> Installing engine -> $EngineDir"
New-Item -ItemType Directory -Force -Path $EngineDir | Out-Null
Copy-Item -Force (Join-Path $repoRoot 'engine\*.ps1') $EngineDir
Write-Host "    copied: $((Get-ChildItem (Join-Path $repoRoot 'engine\*.ps1')).Count) script(s)"

# ---------- 2. plugin ----------
Write-Host "==> Installing DSH plugin -> $PluginsDir"
New-Item -ItemType Directory -Force -Path $PluginsDir | Out-Null
Copy-Item -Force (Join-Path $here 'speech-hook.js') $PluginsDir
$pluginUrl = 'file:///' + ((Join-Path $PluginsDir 'speech-hook.js') -replace '\\', '/' -replace ' ', '%20')

# ---------- 3. register in cordis.patch.yml ----------
# The entry id doubles as the settings namespace on DSH >= 0.1.7 (the settings
# service projects each entry's own Config), so the installer uses the id this
# package documents: dsh-speak. A profile still carrying the pre-1.8.2 row
# (id: speech-hook) is left alone — the browser half binds either id — so a
# re-run never registers the plugin twice.
#
# Two rows, deliberately: `insert` provides the entry, and the TOP-LEVEL row is the
# one the settings page persists into. DSH's config editor rewrites a `config` in
# place only on a top-level row; a `config` nested inside the insert is accepted by
# the UI, applied to the running plugin, and then silently rolled back on disk.
Write-Host "==> Registering plugin in cordis.patch.yml"
if (Test-Path $cordisPatch) {
    $existing = Get-Content $cordisPatch -Raw -Encoding UTF8
    $registered = $existing -match '(?m)^\s*- id:\s*dsh-speak\b'
    $legacy = $existing -match '(?m)^\s*- id:\s*speech-hook\b'
    if ($registered -or $legacy) {
        if ($legacy -and -not $registered) {
            Write-Host "    an older 'id: speech-hook' row already registers dsh-speak — skipping."
            Write-Host "    (optional) rename that row's id to dsh-speak so your saved options live under the documented key."
        } else {
            Write-Host "    dsh-speak already registered — skipping (nothing to do)."
        }
        Write-Host ""
        Write-Host "Done. Restart the DSH web app to pick up the plugin."
        exit 0
    }
    # backup before modifying
    $backup = "$cordisPatch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $cordisPatch $backup
    Write-Host "    backup -> $backup"
    $block = @"

# dsh-speak: auto voice-announce assistant replies (installed by dsh-speak)
# insert = the entry itself; the top-level row is what the settings page edits.
- insert:
    - id: dsh-speak
      name: '$pluginUrl'
- id: dsh-speak
  name: '$pluginUrl'
  config: {}
"@
    Add-Content -Path $cordisPatch -Value $block -Encoding UTF8
    Write-Host "    appended insert + settings entry -> $cordisPatch"
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path $cordisPatch) | Out-Null
    $content = @"
# dsh profile patch layer (created by dsh-speak installer)
# dsh-speak: auto voice-announce assistant replies
# insert = the entry itself; the top-level row is what the settings page edits.
- insert:
    - id: dsh-speak
      name: '$pluginUrl'
- id: dsh-speak
  name: '$pluginUrl'
  config: {}
"@
    Set-Content -Path $cordisPatch -Value $content -Encoding UTF8
    Write-Host "    created -> $cordisPatch"
}

Write-Host ""
Write-Host "Installed. Next steps:"
Write-Host "  1. Restart the DSH web app (profile tree is composed at boot)."
Write-Host "  2. Verify voices: run"
Write-Host "     powershell -NoProfile -ExecutionPolicy Bypass -File `"$EngineDir\speak.ps1`" -Text `"你好，语音播报已就绪。`""
Write-Host "  3. If no sound: install NaturalVoiceSAPIAdapter and register natural voices"
Write-Host "     (see README.md -> Prerequisites)."
