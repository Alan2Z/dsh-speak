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
Write-Host "==> Registering plugin in cordis.patch.yml"
if (Test-Path $cordisPatch) {
    $existing = Get-Content $cordisPatch -Raw -Encoding UTF8
    if ($existing -match '(?m)^\s*- id:\s*speech-hook\b') {
        Write-Host "    speech-hook already registered — skipping (nothing to do)."
        Write-Host ""
        Write-Host "Done. Restart the DSH web app to pick up the plugin."
        exit 0
    }
    # backup before modifying
    $backup = "$cordisPatch.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $cordisPatch $backup
    Write-Host "    backup -> $backup"
    $block = @"

# speech-hook: auto voice-announce assistant replies (installed by dsh-speak)
- insert:
    - id: speech-hook
      name: '$pluginUrl'
"@
    Add-Content -Path $cordisPatch -Value $block -Encoding UTF8
    Write-Host "    appended insert entry -> $cordisPatch"
} else {
    New-Item -ItemType Directory -Force -Path (Split-Path $cordisPatch) | Out-Null
    $content = @"
# dsh profile patch layer (created by dsh-speak installer)
# speech-hook: auto voice-announce assistant replies
- insert:
    - id: speech-hook
      name: '$pluginUrl'
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
