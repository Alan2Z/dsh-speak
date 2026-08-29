# speak.ps1 — Harness-agnostic speech engine (Windows SAPI5 + NaturalVoiceSAPIAdapter)
# ====================================================================================
# Reads text (inline or from a UTF-8 file), cleans it for speech synthesis, and reads
# it aloud through Windows SAPI5, preferring natural voices registered by
# NaturalVoiceSAPIAdapter (https://github.com/gexgd0419/NaturalVoiceSAPIAdapter).
#
# This script knows NOTHING about any harness (DSH, Claude Code, ...). Any process
# can call it:
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File speak.ps1 -Text "hello"
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File speak.ps1 -File C:\tmp\msg.txt
#
# It is best-effort by design: it never throws, never blocks the caller for longer
# than the utterance itself, and exits 0 even if something failed.
#
# Design notes (see docs/DESIGN.md for full rationale):
#   * Markdown symbols, URLs and emoji are stripped before speaking — SAPI5 Speak()
#     silently fails (produces no audio, no error) when it hits emoji/surrogates.
#   * NaturalVoiceSAPIAdapter has a per-Speak character ceiling (~375-470 chars);
#     beyond that it silently speaks nothing. Text longer than $MaxChars is replaced
#     with $LongTextMessage instead.
#   * Adapter-registered voices often have plain names ("Microsoft Xiaoxiao") that do
#     not contain the word "Natural", so matching checks Name + Description.
# ====================================================================================

param(
    [string]$Text = '',
    [string]$File = '',
    [int]$Volume = 50,
    [int]$Rate = 1,
    [int]$MaxChars = 300,
    [string]$LongTextMessage = '本次播报内容较长，请自行阅读。',
    [ValidateSet('message', 'heading')]
    [string]$LongTextMode = 'message',
    # 命令行参数一律是字符串（-File 模式不做类型转换），这里用 [string] 接收，
    # 在脚本内部再转布尔，兼容 '1'/'0'/'true'/'True'/'yes'/'on' 等写法。
    [string]$CleanMarkdownFormatting = 'true',
    [string]$ReadInlineCode = 'true',
    [ValidateSet('all', 'smart', 'replace')]
    [string]$CodeBlocks = 'smart',
    [int]$CodeBlockMaxChars = 300,
    [string]$CodeBlockReplacementText = 'You can see the code in our history.'
)

$cleanMarkdown = $CleanMarkdownFormatting -in @('1', 'true', 'yes', 'on')
$readInlineCode = $ReadInlineCode -in @('1', 'true', 'yes', 'on')

# ---------- input: pick text source ----------
if ($File) {
    if (-not (Test-Path $File)) { exit 0 }
    $text = [System.IO.File]::ReadAllText($File, [System.Text.Encoding]::UTF8)
} else {
    $text = [string]$Text
}
if (-not $text -or -not $text.Trim()) { exit 0 }

# ---------- length guard: adapter per-Speak ceiling ----------
# 'message': fixed prompt. 'heading': speak the largest markdown heading instead
# (fewest '#' wins, tie -> first; no heading -> first non-empty line; the
# cleaned candidate is still subject to the ceiling below).
if ($text.Length -gt $MaxChars -and $LongTextMode -eq 'heading') {
    $candidate = ''
    $bestLevel = 7
    $firstNonEmpty = ''
    foreach ($line in ($text -split "`n")) {
        if ($line -match '^\s*#{1,6}\s+') {
            $level = ([regex]::Match($line, '^(\s*)(#+)')).Groups[2].Value.Length
            if ($level -lt $bestLevel) {
                $bestLevel = $level
                $candidate = $line -replace '^\s*#+\s*', ''
            }
        } elseif (-not $firstNonEmpty -and $line.Trim()) {
            $firstNonEmpty = $line
        }
    }
    if (-not $candidate) { $candidate = $firstNonEmpty }
    if ($candidate) { $text = $candidate }
}

# ---------- clean: Markdown -> natural speech text ----------
if ($cleanMarkdown) {
    $text = [regex]::Replace($text, '```[^\n]*\n?([\s\S]*?)```', {
        param($match)
        $code = $match.Groups[1].Value
        if ($CodeBlocks -eq 'all' -or ($CodeBlocks -eq 'smart' -and $code.Length -le $CodeBlockMaxChars)) { return " $code " }
        return " $CodeBlockReplacementText "
    })
    if ($readInlineCode) { $text = $text -replace '`([^`]*)`', '$1' } else { $text = $text -replace '`[^`]*`', ' ' }
    $text = $text -replace '\[([^\]]*)\]\([^\)]*\)', '$1'
    $text = $text -replace 'https?://\S+', ' '
    $text = $text -replace '(?m)^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)', ' '
    $text = $text -replace '(\*\*|__|~~)(.*?)\1', '$2'
    $text = $text -replace '[*_~]+', ''
}
# Keep all Unicode letters, including Portuguese accents; remove unsafe symbols.
$text = [regex]::Replace($text, '[^\p{L}\p{N}一-龥　-〿＀-￯ -⁯ -~]', '')
$text = $text -replace '\s+', ' '
$text = $text.Trim()

# ---------- final ceiling (also catches over-long heading candidates) ----------
if ($text.Length -gt $MaxChars) { $text = $LongTextMessage }

# ---------- speak ----------
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Volume = $Volume

# prefer a zh natural voice (NaturalVoiceSAPIAdapter-registered), fall back to any zh
$voices = $synth.GetInstalledVoices()
$voice = $voices | Where-Object {
    $_.VoiceInfo.Culture.Name -like 'zh*' -and
    ($_.VoiceInfo.Name + ' ' + $_.VoiceInfo.Description) -match 'Natural|Online'
} | Select-Object -First 1
if (-not $voice) { $voice = $voices | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1 }
if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }

$synth.Rate = $Rate
$synth.Speak($text)
exit 0
