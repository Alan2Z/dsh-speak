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
  TEXT=$(printf '%s' "$TEXT" | /usr/bin/perl -CSD -e '
    my $best = 7; my $cand = ""; my $first = ""; my $inCode = 0;
    while (<STDIN>) {
      if (/^\s*```/) { $inCode = !$inCode; next; }   # 跳过代码块内的 "# 注释"
      next if $inCode;
      if (/^[ \t]*(\#{1,6})[ \t]+(.*)$/) { my $n = length($1); if ($n < $best) { $best = $n; $cand = $2; } }
      elsif ($first eq "" && /\S/) { $first = $_; }
    }
    print($cand eq "" ? $first : $cand);
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
