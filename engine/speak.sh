#!/usr/bin/env bash
# speak.sh — macOS speech engine (uses the built-in `say` command)
# ==============================================================================
# The macOS counterpart of engine/speak.ps1. Reads text (inline or UTF-8 file),
# cleans it for speech synthesis, and reads it aloud via the system `say`
# command. Any process can call it:
#
#   ./speak.sh -t "你好，构建完成"
#   ./speak.sh -f /tmp/msg.txt -v Eddy -r 200
#
# Best-effort by design: never throws, exits 0 even if something failed.
#
# Voice selection:
#   * no -v (default): follow the system voice — on recent macOS this is the
#     Siri voice chosen in Settings > Siri > Voice (e.g. "声音 1"), on older
#     versions the Spoken Content voice. This is the least surprising default.
#   * -v <name>: force a voice by name (e.g. Eddy, Flo, Tingting — see
#     `say -v '?'`).
#   * NOTE: the Siri voices ("声音 1-4") are NOT exposed to `say` — they do not
#     appear in `say -v '?'` and cannot be selected by name; they only work as
#     the system default.
#
# Notes:
#   * LC_ALL is pinned to a UTF-8 locale so the perl cleaning pipeline and bash
#     character counting behave identically regardless of the caller's locale
#     (a C/POSIX locale would silently strip all CJK text).
#   * The cleaning pipeline mirrors speak.ps1 (markdown/URL/emoji stripped).
#   * `say` has no volume flag — volume is controlled by the system output.
#   * Length guard: text over $MAX_CHARS is replaced with $LONG_MSG.
# ==============================================================================

export LC_ALL="${LC_ALL:-en_US.UTF-8}"

TEXT=""
FILE=""
VOICE=""
RATE=175          # words per minute (say default)
MAX_CHARS=300
LONG_MSG="本次播报内容较长，请自行阅读。"
LONG_MODE="message"   # message | heading

usage() {
  echo "usage: speak.sh [-t text | -f file] [-v voice] [-r wpm] [-m maxchars] [-l longmsg] [-M message|heading]" >&2
  exit 1
}

while getopts "t:f:v:r:m:l:M:h" opt; do
  case "$opt" in
    t) TEXT="$OPTARG" ;;
    f) FILE="$OPTARG" ;;
    v) VOICE="$OPTARG" ;;
    r) RATE="$OPTARG" ;;
    m) MAX_CHARS="$OPTARG" ;;
    l) LONG_MSG="$OPTARG" ;;
    M) LONG_MODE="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done

# ---------- input ----------
if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || exit 0
  TEXT=$(/usr/bin/perl -CSD -e 'print <>' "$FILE")
fi
if [ -z "$TEXT" ]; then exit 0; fi

# ---------- length guard / long-text mode ----------
# 'message': fixed prompt. 'heading': speak the largest markdown heading instead
# (fewest '#' wins, tie -> first; no heading -> first non-empty line; the
# cleaned candidate is still subject to the ceiling below).
if [ "${#TEXT}" -gt "$MAX_CHARS" ] && [ "$LONG_MODE" = "heading" ]; then
  TEXT=$(printf '%s' "$TEXT" | /usr/bin/perl -CSD -e '
    my $best = 7; my $cand = ""; my $first = "";
    while (<STDIN>) {
      if (/^[ \t]*(\#{1,6})[ \t]+(.*)$/) {
        my $n = length($1);
        if ($n < $best) { $best = $n; $cand = $2; }
      } elsif ($first eq "" && /\S/) {
        $first = $_;
      }
    }
    $cand = $first if $cand eq "";
    print $cand;
  ')
fi

# ---------- clean (mirrors speak.ps1) ----------
TEXT=$(printf '%s' "$TEXT" | /usr/bin/perl -CSD -pe '
  s/```[\s\S]*?```/ /g;          # code blocks
  s/`[^`]*`/ /g;                  # inline code
  s/\[([^\]]*)\]\([^\)]*\)/$1/g;  # markdown links
  s|https?://\S+| |g;             # bare URLs
  s/[-#*_~|>+]+/ /g;              # emphasis / marker chars
  s/[^\p{Han}\x{3000}-\x{303F}\x{FF00}-\x{FFEF}\x{2000}-\x{206F}\x{20}-\x{7E}]//g;  # emoji / specials
  s/\s+/ /g;                      # collapse whitespace
')
TEXT=$(printf '%s' "$TEXT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')

# ---------- final ceiling (also catches over-long heading candidates) ----------
if [ "${#TEXT}" -gt "$MAX_CHARS" ]; then
  TEXT="$LONG_MSG"
fi

# ---------- speak (no -v => system default voice) ----------
if [ -n "$VOICE" ]; then
  say -v "$VOICE" -r "$RATE" "$TEXT"
else
  say -r "$RATE" "$TEXT"
fi
exit 0
