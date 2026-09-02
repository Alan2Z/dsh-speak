# speech-summary.ps1 — Reply summary announcement (synchronous, blocking)
# For harnesses with no "reply finished" event (e.g. DSH has no Stop hook): the
# agent calls this at the end of its final reply.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File speech-summary.ps1 -Text "总结文本"
#
# NOTE: keep this SYNCHRONOUS. An earlier version spawned the inner powershell
# asynchronously with Start-Process; DSH's sandbox blocks nested sub-process
# spawning, so it silently produced no audio. The synchronous call chain
# (summary -> speak.ps1) is the reliable path (cost: caller waits for the
# utterance to finish).

param([string]$Text = '')

if (-not $Text) { exit 0 }

$speak = Join-Path $PSScriptRoot 'speak.ps1'
if (-not (Test-Path $speak)) { exit 0 }

$tmp = Join-Path $env:TEMP ('speech-summary-' + [guid]::NewGuid().ToString('N') + '.txt')
try {
    [System.IO.File]::WriteAllText($tmp, $Text, [System.Text.UTF8Encoding]::new($false))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $speak -File $tmp
    exit $LASTEXITCODE
} finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
