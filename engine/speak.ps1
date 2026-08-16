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
    [string]$LongTextMode = 'message'
)

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

# ---------- clean: markdown -> plain speech text ----------
# code blocks, inline code, markdown links, bare URLs, emphasis/marker chars
$text = $text -replace '```[\s\S]*?```', ' '
$text = $text -replace '`[^`]*`', ' '
$text = $text -replace '\[([^\]]*)\]\([^\)]*\)', '$1'
$text = $text -replace 'https?://\S+', ' '
$text = $text -replace '[-#*_~|>+]+', ' '
# emoji / special symbols (Speak() fails silently on them): keep CJK, CJK punct,
# full-width ranges, ASCII printable
$text = [regex]::Replace($text, '[^一-龥　-〿＀-￯ -⁯ -~]', '')
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
