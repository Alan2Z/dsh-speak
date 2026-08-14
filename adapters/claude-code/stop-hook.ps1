# stop-hook.ps1 — Claude Code adapter: announce the final reply via the Stop hook
# ================================================================================
# Claude Code invokes Stop hooks after a reply finishes and feeds a JSON payload
# (with transcript_path) on stdin. This script finds the last assistant text in
# the transcript and announces it through the shared engine (engine/speak.ps1).
#
# Register in ~/.claude/settings.json:
#   "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File <repo>\\adapters\\claude-code\\stop-hook.ps1" } ] } ] }
#
# Notes:
#   * async by design: the announcement runs in its own hidden powershell process
#     so Claude Code is never blocked (the nested-spawn limitation only applies
#     inside DSH's sandbox, not here)
#   * best-effort: any failure exits 0 silently

param()

# ---------- read Claude Code hook JSON from stdin ----------
$json = [Console]::In.ReadToEnd()
if (-not $json) { exit 0 }
try { $obj = $json | ConvertFrom-Json } catch { exit 0 }
$transcript = $obj.transcript_path
if (-not $transcript -or -not (Test-Path $transcript)) { exit 0 }

# ---------- find last assistant message with text (last entry is often a pure tool call) ----------
$lines = [System.IO.File]::ReadAllLines($transcript, [System.Text.Encoding]::UTF8)
$text = ''
for ($i = $lines.Length - 1; $i -ge 0; $i--) {
    try { $rec = $lines[$i] | ConvertFrom-Json } catch { continue }
    if ($rec.type -ne 'assistant') { continue }
    $content = $rec.message.content
    if ($content -is [string]) {
        $text = $content
    } else {
        $parts = @()
        foreach ($c in $content) {
            if ($c.type -eq 'text' -and $c.text) { $parts += $c.text }
        }
        $text = $parts -join ''
    }
    if ($text) { break }
}
$text = [string]$text
if (-not $text) { exit 0 }

# ---------- write to temp file and speak asynchronously (hook returns immediately) ----------
$speak = Join-Path $PSScriptRoot '..\..\engine\speak.ps1'
if (-not (Test-Path $speak)) { exit 0 }
$tmp = Join-Path $env:TEMP 'claude_code_speech.txt'
try {
    [System.IO.File]::WriteAllText($tmp, $text, [System.Text.Encoding]::UTF8)
    Start-Process powershell -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
        '-File', $speak, '-File', $tmp
    )
} catch {
    # best-effort: never disturb Claude Code
}
exit 0
