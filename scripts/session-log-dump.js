// session-log-dump.js — read a DSH session log without a running harness.
// ==============================================================================
// Manual dev helper (NOT part of `npm test`). It exists because the only other
// way to learn what dsh-speak actually handed to the engine is the plugin's own
// log line, which records just the first 80 characters — too little to tell a
// truncated utterance from a complete one. Reading the session log gives the
// EXACT message text, which can then be fed to the engine's `-DryRun` switch to
// see what would be spoken, with no audio.
//
//   node scripts/session-log-dump.js <session.v3.jsonl.zstd>              # list recent assistant messages
//   node scripts/session-log-dump.js <session.v3.jsonl.zstd> seq:1908     # dump one message verbatim (for -DryRun)
//   node scripts/session-log-dump.js <session.v3.jsonl.zstd> <substring>  # find messages containing a substring
//
// Where the log lives: <DSH_HOME>/sessions/<mangled-cwd>/session-<id>/session.v3.jsonl.zstd
//
// Format note (DSH session format v3): the file is a CONCATENATION of independent
// zstd frames — one per append batch, ~1200 of them in a busy session — with no
// length prefix. Node's zstd API decodes only the FIRST frame of a buffer, so
// frame starts are located by treating every `28 b5 2f fd` occurrence as a
// candidate and keeping the ones that actually decode. Only the newest 400
// frames are decoded (scanning from the tail), which is enough for recent work.
//
// Requires Node with zstd support (zlib.zstdDecompressSync, Node >= 22.15).
'use strict'
const fs = require('fs')
const z = require('zlib')

if (typeof z.zstdDecompressSync !== 'function') {
  console.error('session-log-dump: this Node build has no zlib.zstdDecompressSync (needs Node >= 22.15)')
  process.exit(2)
}

const file = process.argv[2]
const want = process.argv.slice(3)
if (!file) {
  console.error('usage: node scripts/session-log-dump.js <session.v3.jsonl.zstd> [seq:N | <substring> ...]')
  process.exit(2)
}

const MAX_FRAMES = 400
const buf = fs.readFileSync(file)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/** Offsets of every candidate zstd frame start (real frames plus false positives). */
const offsets = []
for (let i = 0; i + 3 < buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
}

/** Newest frames first, skipping the candidates that are not frame starts. */
const frames = []
for (let i = offsets.length - 1; i >= 0 && frames.length < MAX_FRAMES; i--) {
  try {
    frames.push(z.zstdDecompressSync(buf.subarray(offsets[i])).toString('utf8'))
  } catch (e) { /* magic bytes inside compressed data, not a frame boundary */ }
}
console.error(`frames: ${offsets.length} candidates, ${frames.length} decoded`)

const seqMode = want.length === 1 && want[0].startsWith('seq:')
const lines = []
for (const text of frames) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    if (seqMode || want.length === 0 || want.some(w => line.includes(w))) lines.push(line)
  }
}

// Oldest first, so the reading order matches the conversation.
for (const line of lines.reverse()) {
  let event
  try { event = JSON.parse(line) } catch (e) { console.log('RAW', line.slice(0, 200)); continue }
  if (event.type !== 'assistant/message') continue
  const data = event.data || {}
  const message = data.message || event.message
  const blocks = message && Array.isArray(message.content) ? message.content : []
  const text = blocks.filter(block => block && block.type === 'text').map(block => block.text).join('')
  if (!text.length) continue
  if (seqMode) {
    if (String(event.seq) !== want[0].slice(4)) continue
    process.stdout.write(text)          // verbatim, so it can be piped to engine -DryRun
    console.error(`dumped seq ${event.seq}: ${text.length} chars`)
    continue
  }
  console.log(`seq=${event.seq} len=${text.length} :: ${text.slice(0, 70).replace(/\n/g, '\\n')}`)
}
