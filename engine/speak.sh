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
# Voice selection (auto when -v is omitted):
#   prefers the newer natural zh-CN voices Eddy / Flo (macOS 14+), falls back to
#   Tingting (婷婷), then to whatever `say` auto-selects. There is no Chinese
#   "Siri Voice" yet — Siri voices are English-only.
#
# Notes:
#   * The cleaning pipeline mirrors speak.ps1 (markdown/URL/emoji stripped before
#     speaking).
#   * `say` has no volume flag — volume is controlled by the system output
#     volume, so -Volume from the Windows API has no macOS equivalent.
#   * Length guard: `say` chokes on very long input; text over $MAX_CHARS is
#     replaced with $LONG_MSG (same default as the Windows engine).
# ==============================================================================

TEXT=""
FILE=""
VOICE=""
RATE=175          # words per minute (say default)
MAX_CHARS=300
LONG_MSG="本次播报内容较长，请自行阅读。"

usage() {
  echo "usage: speak.sh [-t text | -f file] [-v voice] [-r wpm] [-m maxchars] [-l longmsg]" >&2
  exit 1
}

while getopts "t:f:v:r:m:l:h" opt; do
  case "$opt" in
    t) TEXT="$OPTARG" ;;
    f) FILE="$OPTARG" ;;
    v) VOICE="$OPTARG" ;;
    r) RATE="$OPTARG" ;;
    m) MAX_CHARS="$OPTARG" ;;
    l) LONG_MSG="$OPTARG" ;;
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

# ---------- length guard ----------
if [ "${#TEXT}" -gt "$MAX_CHARS" ]; then
  TEXT="$LONG_MSG"
fi

# ---------- voice preference ----------
if [ -z "$VOICE" ]; then
  VOICES=$(say -v '?' 2>/dev/null)
  for v in Eddy Flo Tingting; do
    if printf '%s' "$VOICES" | grep -q "^$v "; then
      VOICE="$v"
      break
    fi
  done
fi

# ---------- speak ----------
if [ -n "$VOICE" ]; then
  say -v "$VOICE" -r "$RATE" "$TEXT"
else
  say -r "$RATE" "$TEXT"
fi
exit 0
