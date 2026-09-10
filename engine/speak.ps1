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
    # 本脚本唯一的非 ASCII 代码字面量。丢了 UTF-8 BOM 时 PowerShell 5.1 会按 ANSI
    # 代码页把它解码成乱码——DSH 插件总是显式传 -LongTextMessage，所以只影响手动
    # CLI 调用；脚本逻辑（句末判定 / 字符过滤 / 分句）已全部改成纯 ASCII 源码。
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
    [string]$CodeBlockReplacementText = 'You can see the code in our history.',
    # 手动重播完整朗读：跳过超长文本的 heading/message 截断，分段完整朗读
    [string]$FullRead = '0',
    # 只把「将要朗读的文本」按 UTF-8 写到 stdout、完全不出声（调试清洗与长文
    # 守卫用；正常调用无需传，插件不会传）
    [string]$DryRun = '0'
)

$cleanMarkdown = $CleanMarkdownFormatting -in @('1', 'true', 'yes', 'on')
$readInlineCode = $ReadInlineCode -in @('1', 'true', 'yes', 'on')
$dryRunMode = $DryRun -in @('1', 'true', 'yes', 'on')
# 注意：PowerShell 变量大小写不敏感，内部变量名不能与参数名仅差大小写
# （曾用 $fullRead 导致自赋值污染参数 $FullRead，使 -not 判断失效）
$fullReadMode = $FullRead -in @('1', 'true', 'yes', 'on')

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
# (fewest '#' wins, tie -> first; with NO heading, speak a coherent opening of
# the text — see below; the cleaned candidate is still subject to the ceiling
# below). FullRead 手动重播跳过该守卫（见文件底部"完整朗读"分支）。
if (-not $fullReadMode -and $MaxChars -gt 0 -and $text.Length -gt $MaxChars -and $LongTextMode -eq 'heading') {
    $candidate = ''
    $bestLevel = 7
    # 代码块 fence 内的行跳过：其中的 "# 注释" 不是 markdown 标题，
    # 否则长回复里的代码注释会被误当成标题只念注释
    $inCodeBlock = $false
    foreach ($line in ($text -split "`n")) {
        if ($line -match '^\s*```') { $inCodeBlock = -not $inCodeBlock; continue }
        if ($inCodeBlock) { continue }
        if ($line -match '^\s*#{1,6}\s+') {
            $level = ([regex]::Match($line, '^(\s*)(#+)')).Groups[2].Value.Length
            if ($level -lt $bestLevel) {
                $bestLevel = $level
                $candidate = $line -replace '^\s*#+\s*', ''
            }
        }
    }
    if ($candidate) {
        # 有标题：只念最大的标题（"长回复只报标题"）
        $text = $candidate
    } else {
        # 没有标题：**不能只念第一个非空行** —— 那会念出"……官方文档写明："这类
        # 断头句然后静默停住，听感上就是"从第二行开始不念了"（1.8.0 修复）。
        # 改为取开头 MaxChars 长度的窗口，并在窗口内最后一个句末标点处收尾。
        # 中英双语判据：
        #   * 全角 。！？； 与省略号 … 无条件算句末（中文标点不含歧义）；
        #   * 半角 .!?; 只在后面跟空白、右引号/右括号时才算，否则 "0.1.2"、
        #     "file.txt"、"e.g." 里的小数点/扩展名会被当成句子结尾；
        #   * 半角标点不认"到窗口结尾"本身就结束：窗口末尾若是小数点，认了等于没
        #     修剪。但会多读一位来判断（见下），所以"句号+空格"在窗口边缘照样成立。
        # 收尾后若不足半个窗口，就保留整个窗口：一整句超长文本不该被砍成一个词。
        #
        # 标点类一律用 [char] 码位拼出来，让源码里**不出现非 ASCII 代码字面量**：
        #   1) PowerShell 把 ’ ” ‘ “ 也当字符串引号，直接写进单引号串会提前截断
        #      （报 Missing ')' in method call）；
        #   2) 更要紧的是——脚本一旦丢掉 UTF-8 BOM，Windows PowerShell 5.1 会按
        #      ANSI 代码页解码，代码里的中文标点会变乱码，句末判定**静默失效**。
        #      代码保持纯 ASCII 后，丢 BOM 只会让中文注释变乱码，不影响行为。
        #   。 ！ ？ ； … = 0x3002 0xFF01 0xFF1F 0xFF1B 0x2026
        #   ） 】 」 』 = 0xFF09 0x3011 0x300D 0x300F
        $fullWidthEnders = [string]([char]0x3002) + [char]0xFF01 + [char]0xFF1F + [char]0xFF1B + [char]0x2026
        $closers = [string]([char]0x22) + [char]0x201D + [char]0x2019 + [char]0xFF09 + [char]0x3011 + [char]0x300D + [char]0x300F + [char]0x29 + '\' + [char]0x5D + [char]0x7D
        $sentenceEndPattern = '(?:[' + $fullWidthEnders + ']|[.!?;](?=[\s' + $closers + ']))'
        $window = $text.Substring(0, [Math]::Min($text.Length, $MaxChars))
        # 多看一个字符再判定，但只在窗口内收尾：句号落在窗口最后一位时，它后面那个
        # 空格在窗口之外，多看一位才能认出"句号+空格"确实是句末；而"句号+数字"
        # （`Version 0.1.` 的第 300 位）依旧被拒。切点永远不超过窗口长度。
        $scan = $text.Substring(0, [Math]::Min($text.Length, $MaxChars + 1))
        # 取**落在窗口内**的最后一个句末标点：scan 多读的那一位会让最后一个匹配可能
        # 落在窗口之外（窗口外正好是个全角句号时），那种匹配必须忽略——但也不能因此
        # 丢掉窗口内更早的合法边界，所以逐个过滤而不是只看最后一个。
        $cut = 0
        foreach ($match in [regex]::Matches($scan, $sentenceEndPattern)) {
            $end = $match.Index + $match.Length
            if ($end -le $window.Length) { $cut = $end }
        }
        if ($cut -ge [Math]::Floor($window.Length / 2)) { $window = $window.Substring(0, $cut) }
        $text = $window
    }
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
# 范围写成 \u 转义（纯 ASCII 源码，丢 BOM 也不会乱码）：
#   \u4e00-\u9fa5 汉字、\u3000-\u303f 中文标点、\uff00-\uffef 全角、
#   \u2000-\u206f 通用标点（含 … 和 —）、\u0020-\u007e ASCII 可打印。
$text = [regex]::Replace($text, '[^\p{L}\p{N}\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef\u2000-\u206f\u0020-\u007e]', '')
$text = $text -replace '\s+', ' '
$text = $text.Trim()

# ---------- final ceiling (also catches over-long heading candidates) ----------
if (-not $fullReadMode -and $text.Length -gt $MaxChars) { $text = $LongTextMessage }

# ---------- dry run: expose the text that would be spoken, silently ----------
# Maintainer aid: makes the cleaning pipeline and the long-text guard observable
# without a speaker, so a truncated candidate can be diffed against its source.
# Written as raw UTF-8 bytes so a redirected capture never depends on the
# console code page.
if ($dryRunMode) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
    [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
    exit 0
}

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

# ---------- 完整朗读（FullRead，手动重播） ----------
# Windows SAPI 单次 Speak 有约 375-470 字上限，超长会静默失败；因此按句末
# 标点切成不超过 450 字的段，逐段朗读（自动播报不经过这里，走上面的守卫）。
$SPEAK_CHUNK = 400
if ($fullReadMode -and $text.Length -gt $SPEAK_CHUNK) {
    # 分句标点同样用 \u 转义（纯 ASCII 源码）
    $parts = [regex]::Split($text, '(?<=[\u3002\uff01\uff1f\uff1b.!?;])')
    $chunk = ''
    foreach ($part in $parts) {
        if ($part.Length -eq 0) { continue }
        if ($chunk.Length + $part.Length -gt $SPEAK_CHUNK) {
            if ($chunk) { $synth.Speak($chunk); $chunk = '' }
            # 单段仍超长：硬切
            while ($part.Length -gt $SPEAK_CHUNK) {
                $synth.Speak($part.Substring(0, $SPEAK_CHUNK))
                $part = $part.Substring($SPEAK_CHUNK)
            }
            $chunk = $part
        } else {
            $chunk += $part
        }
    }
    if ($chunk) { $synth.Speak($chunk) }
} else {
    $synth.Speak($text)
}
exit 0
