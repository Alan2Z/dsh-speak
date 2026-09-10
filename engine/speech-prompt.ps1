# speech-prompt.ps1 — Short prompt announcement (synchronous, blocking)
# Use when a harness/agent needs the user's attention (a question, an approval
# request). Reads the text through engine/speak.ps1 and waits until it finishes,
# so the caller knows the announcement was actually spoken.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File speech-prompt.ps1 -Text "请做出选择"

# 唯一的非 ASCII 代码字面量：丢 UTF-8 BOM 时 PowerShell 5.1 会按 ANSI 代码页把它
# 解码成乱码——调用方通常显式传 -Text，所以只影响不带参数的调用。
param([string]$Text = '请做出选择')

if (-not $Text) { exit 0 }

$speak = Join-Path $PSScriptRoot 'speak.ps1'
if (-not (Test-Path $speak)) { exit 0 }

$tmp = Join-Path $env:TEMP ('speech-prompt-' + [guid]::NewGuid().ToString('N') + '.txt')
try {
    [System.IO.File]::WriteAllText($tmp, $Text, [System.Text.UTF8Encoding]::new($false))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $speak -File $tmp
    exit $LASTEXITCODE
} finally {
    if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
}
