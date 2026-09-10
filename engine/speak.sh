#!/usr/bin/env bash
# speak.sh — macOS speech engine (uses the built-in `say` command)
# ==================================================================
# Reads text (inline or UTF-8 file), optionally converts Markdown into natural
# speech text, and reads it aloud with the system voice. A zero max length means
# unlimited text, which is safe for macOS `say`.

export LC_ALL="${LC_ALL:-en_US.UTF-8}"

TEXT=""
FILE=""
VOICE=""
RATE=175
MAX_CHARS=0
LONG_MSG="本次播报内容较长，请自行阅读。"
LONG_MODE="message"
CLEAN_MARKDOWN=1
READ_INLINE_CODE=1
CODE_BLOCKS="smart"
CODE_BLOCK_MAX_CHARS=300
CODE_BLOCK_REPLACEMENT="You can see the code in our history."
FULL_READ=0

usage() {
  echo "usage: speak.sh [-t text | -f file] [-v voice] [-r wpm] [-m maxchars] [-l longmsg] [-M message|heading] [-C 0|1] [-I 0|1] [-B all|smart|replace] [-K codechars] [-R replacement] [-F]" >&2
  exit 1
}

while getopts "t:f:v:r:m:l:M:C:I:B:K:R:Fh" opt; do
  case "$opt" in
    t) TEXT="$OPTARG" ;;
    f) FILE="$OPTARG" ;;
    v) VOICE="$OPTARG" ;;
    r) RATE="$OPTARG" ;;
    m) MAX_CHARS="$OPTARG" ;;
    l) LONG_MSG="$OPTARG" ;;
    M) LONG_MODE="$OPTARG" ;;
    C) CLEAN_MARKDOWN="$OPTARG" ;;
    I) READ_INLINE_CODE="$OPTARG" ;;
    B) CODE_BLOCKS="$OPTARG" ;;
    K) CODE_BLOCK_MAX_CHARS="$OPTARG" ;;
    R) CODE_BLOCK_REPLACEMENT="$OPTARG" ;;
    F) FULL_READ=1 ;;
    h) usage ;;
    *) usage ;;
  esac
done

if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || exit 0
  TEXT=$(/usr/bin/perl -CSD -e 'print <>' "$FILE")
fi
[ -n "$TEXT" ] || exit 0

# `heading` is meaningful only when a positive long-text ceiling is configured.
# -F (full read, manual replay) skips this guard entirely.
if [ "$FULL_READ" != "1" ] && [ "$MAX_CHARS" -gt 0 ] && [ "${#TEXT}" -gt "$MAX_CHARS" ] && [ "$LONG_MODE" = "heading" ]; then
  export DSH_SPEAK_MAX_CHARS="$MAX_CHARS"
  TEXT=$(printf '%s' "$TEXT" | /usr/bin/perl -CSD -e '
    my $text = do { local $/; <STDIN> };
    my $best = 7; my $cand = ""; my $inCode = 0;
    for my $line (split /\n/, $text, -1) {
      $line =~ s/\r$//;
      if ($line =~ /^\s*```/) { $inCode = !$inCode; next; }   # 跳过代码块内的 "# 注释"
      next if $inCode;
      if ($line =~ /^[ \t]*(\#{1,6})[ \t]+(.*)$/) { my $n = length($1); if ($n < $best) { $best = $n; $cand = $2; } }
    }
    if ($cand ne "") { print $cand; exit }
    # 没有标题：**不能只念第一个非空行**（会念出"……写明："这种断头句然后静默
    # 停住，听感上就是"从第二行开始不念了"）。改为取开头 MaxChars 窗口，并在窗口
    # 内最后一个句末标点处收尾。中英双语判据与 speak.ps1 保持一致：
    #   * 全角 。！？；… 无条件算句末；
    #   * 半角 .!?; 只在后面跟空白、右引号/右括号时才算，否则
    #     "0.1.2"、"file.txt"、"e.g." 里的小数点/扩展名会被当成句末；
    #   * 半角标点不认"到窗口结尾"本身就结束：窗口末尾若是小数点，认了等于没修剪。
    #     但会多读一位来判断，所以"句号+空格"在窗口边缘照样成立。
    # 收尾后若不足半个窗口，就保留整个窗口，避免一整句超长文本被砍成一个词。
    #
    # 标点一律写成 \x{...} 码位转义，让这段 Perl 源码保持**纯 ASCII**：Perl 源码默认
    # 按字节处理（这里没有 use utf8），直接写中文标点会被当成 Latin-1 单字节字符，
    # 模式就再也匹配不到解码后的正文，表现为**完全不修剪**（1.8.0 实测踩到）。
    # 码位与 speak.ps1 里 [char] 构造的集合一一对应：
    #   。 ！ ？ ； …   = \x{3002} \x{FF01} \x{FF1F} \x{FF1B} \x{2026}
    #   ） 】 」 』 = \x{FF09} \x{3011} \x{300D} \x{300F}
    #   " ” ’ ) ] }    = " \x{201D} \x{2019} ) ] }
    my $max = $ENV{DSH_SPEAK_MAX_CHARS} || 300;
    my $window = length($text) > $max ? substr($text, 0, $max) : $text;
    my $scan = length($text) > $max + 1 ? substr($text, 0, $max + 1) : $text;
    my @ends;
    while ($scan =~ /(?:[\x{3002}\x{FF01}\x{FF1F}\x{FF1B}\x{2026}]|[.!?;](?=[\s"\x{201D}\x{2019}\)\]\}\x{FF09}\x{3011}\x{300D}\x{300F}]))/g) { push @ends, pos($scan); }
    # 只认落在窗口内的最后一个句末标点：多读的那一位可能让最后一个匹配落在窗口
    # 之外，那种匹配要忽略，但不能因此丢掉窗口内更早的合法边界。
    my $cut = 0;
    foreach my $end (@ends) { $cut = $end if $end <= length($window); }
    $window = substr($window, 0, $cut) if $cut >= int(length($window) / 2);
    print $window;
  ')
fi

if [ "$CLEAN_MARKDOWN" = "1" ]; then
  export DSH_SPEAK_CODE_BLOCKS="$CODE_BLOCKS"
  export DSH_SPEAK_CODE_BLOCK_MAX_CHARS="$CODE_BLOCK_MAX_CHARS"
  export DSH_SPEAK_CODE_BLOCK_REPLACEMENT="$CODE_BLOCK_REPLACEMENT"
  export DSH_SPEAK_READ_INLINE_CODE="$READ_INLINE_CODE"
  TEXT=$(printf '%s' "$TEXT" | /usr/bin/perl -CSD -0pe '
    my $mode = $ENV{DSH_SPEAK_CODE_BLOCKS} || "smart";
    my $limit = $ENV{DSH_SPEAK_CODE_BLOCK_MAX_CHARS} || 300;
    my $replacement = $ENV{DSH_SPEAK_CODE_BLOCK_REPLACEMENT} || "";
    s{```[^\n]*\n?(.*?)```}{
      my $code = $1;
      $mode eq "all" || ($mode eq "smart" && length($code) <= $limit) ? " $code " : " $replacement ";
    }gse;
    if (($ENV{DSH_SPEAK_READ_INLINE_CODE} || "1") eq "1") { s/`([^`]*)`/$1/g; }
    else { s/`[^`]*`/ /g; }
    s/\[([^\]]*)\]\([^\)]*\)/$1/g;
    s|https?://\S+| |g;
    s/^\s{0,3}(?:\#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/ /gm;
    s/(\*\*|__|~~)(.*?)\1/$2/g;
    s/[\*_~]+//g;
  ')
fi

# Retain all letters (including Portuguese accents) and numbers, while removing
# emoji/symbols that make the native synthesizer unreliable.
TEXT=$(printf '%s' "$TEXT" | /usr/bin/perl -CSD -pe '
  s/[^\p{L}\p{N}\p{Han}\x{3000}-\x{303F}\x{FF00}-\x{FFEF}\x{2000}-\x{206F}\x{20}-\x{7E}]//g;
  s/\s+/ /g;
')
TEXT=$(printf '%s' "$TEXT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

if [ "$FULL_READ" != "1" ] && [ "$MAX_CHARS" -gt 0 ] && [ "${#TEXT}" -gt "$MAX_CHARS" ]; then TEXT="$LONG_MSG"; fi
[ -n "$TEXT" ] || exit 0

if [ -n "$VOICE" ]; then say -v "$VOICE" -r "$RATE" "$TEXT"; else say -r "$RATE" "$TEXT"; fi
exit 0
