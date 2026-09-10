// test-engine-longtext.js — the length guard's contract, for BOTH engines.
// ==============================================================================
// The long-text guard is the one piece of the engine whose behaviour is not
// obvious from the outside, and it has produced two user-visible bugs:
//
//   * `longTextMode: heading` with no markdown heading spoke only the FIRST
//     NON-EMPTY LINE, so a long multi-line reply was announced as a dangling
//     fragment ("…the docs say:") and then went silent (fixed in 1.8.0).
//   * the sentence-boundary trim must stay bilingual: full-width 。！？；… always
//     end a sentence, half-width .!?; only when followed by whitespace, a closing
//     quote/bracket, or the end — otherwise `0.1.5`, `speak.ps1` and `e.g.` are
//     mistaken for sentence ends.
//
// Both engines implement that guard (speak.ps1 in PowerShell, speak.sh in a Perl
// one-liner) and this file checks both against the same fixtures. speak.ps1 is
// exercised through its `-DryRun` switch (the real pipeline, no audio); speak.sh's
// Perl program is EXTRACTED from the shipped script so the test tracks the real
// code rather than a copy that can drift.
//
// Windows-only for the PowerShell half; the Perl half also runs on macOS/Linux.
'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const engineDir = path.join(__dirname, '..', 'engine')
const ps1 = path.join(engineDir, 'speak.ps1')
const sh = path.join(engineDir, 'speak.sh')
const MAX_CHARS = 300

// ---------------------------------------------------------------------------
// Fixtures: each is the raw text handed to the engine, with the properties the
// guard must preserve. `heading` fixtures must collapse to the heading itself;
// every other fixture must keep reading well past the first line and stop on a
// sentence boundary.
// ---------------------------------------------------------------------------
const PAD = '这一段正文用来堆长度，让窗口稳稳越过三百字的门槛，同时保证句末标点齐全。'
const LONG_NO_HEADING = '第一段说明文字，它本身很短，旧版引擎会在这里就停住。\n\n'
  + '这是紧接着的第二段正文，旧版引擎从这一行开始就不会再念了。' + PAD.repeat(12)
const LONG_WITH_HEADING = '请看下面的标题。\n\n## 标题模式对照测试\n\n' + PAD.repeat(10)
const LONG_BLOCKQUOTE = '这是带引用块的长文复现。\n\n> 这一段是引用内容，旧版引擎念到第二行就停住。\n\n'
  + '引用块之后还有正文。' + PAD.repeat(10)
const LONG_ENGLISH = 'Here is an English paragraph used to check the sentence boundary logic. '
  + 'It has several sentences so the window can end at a real sentence end. '
  + 'The engine should stop right after a period followed by a space, not in the middle of a phrase. '
  + 'Padding continues here to push the text well past three hundred characters so the guard fires. '
  + 'Another sentence follows to make sure there are candidates inside the window. And a final sentence closes it out.'
const LONG_ELLIPSIS = '这是一段测试省略号的中文文本…… 后面还有内容继续填充，让长度超过三百字，确保守卫一定触发。'
  + PAD.repeat(9)
const LONG_DECIMAL = 'Version 0.1.5 changed things.结果块被包进了 ToolResultBlock。插件却从外层块上取文本。'
  + PAD.repeat(9)
// The window itself ends on a decimal point: 199 甲 + 。 (boundary at 199) + 98 乙 + "0."
// puts `.` at the LAST position of the 300-char window, with a digit right after it.
// Half-width marks must not be accepted just because the window ends there, or the
// "trim" cuts mid-number and effectively does nothing (the bug this fixture pins).
const LONG_DECIMAL_EDGE = '甲'.repeat(199) + '。' + '乙'.repeat(98) + '0.' + '1.5 ' + '丙'.repeat(50)
// The mirror case: the window ends on a period that IS a sentence end ("ok." followed by
// a space one character PAST the window). The boundary scan therefore reads one character
// beyond the window while still never cutting past it — English "period + space" must hold
// even at the window edge.
const LONG_EN_PERIOD_EDGE = '甲'.repeat(199) + '。' + '乙'.repeat(97) + 'ok.' + ' ' + '丙'.repeat(60)
// The character filter is written with \u escapes so the engine's CODE stays ASCII-only
// (a lost BOM then garbles comments and the default prompt, not the logic). This fixture
// pins what that filter must keep and drop: emoji are the classic silent-SAPI killer.
const EMOJI_SAMPLE = '中文保留😀🎉表情要被剥离。'.repeat(16) + '结尾。'
// The window's last character is a valid boundary, but the boundary ONE PAST the window
// is also a full-width ender: taking "the last match" blindly would discard the in-window
// one and skip the trim entirely. The last match must be filtered to the window.
const LONG_BOUNDARY_PAST_WINDOW = '甲'.repeat(199) + '。' + '乙'.repeat(100) + '。' + '丙'.repeat(60)
// `maxChars: 0` with heading mode: the guard's entry condition must keep its `MaxChars > 0`
// check (speak.sh always had it) — otherwise the window is the EMPTY string and the
// utterance becomes silence instead of the long-text notice.
const MAXCHARS_ZERO = PAD.repeat(10)

const FIXTURES = [
  { name: 'long-plain', text: LONG_NO_HEADING, expectHeading: null, mustContain: '第二段正文' },
  { name: 'long-blockquote', text: LONG_BLOCKQUOTE, expectHeading: null, mustContain: '这一段是引用内容' },
  { name: 'long-heading', text: LONG_WITH_HEADING, expectHeading: '标题模式对照测试' },
  { name: 'long-english', text: LONG_ENGLISH, expectHeading: null, mustContain: 'sentence boundary logic' },
  { name: 'long-ellipsis', text: LONG_ELLIPSIS, expectHeading: null, mustContain: '测试省略号' },
  { name: 'long-decimal', text: LONG_DECIMAL, expectHeading: null, mustContain: 'Version 0.1.5 changed things' },
  { name: 'long-decimal-edge', text: LONG_DECIMAL_EDGE, expectHeading: null, mustEndWith: '。', maxLength: 250 },
  { name: 'long-en-period-edge', text: LONG_EN_PERIOD_EDGE, expectHeading: null, mustEndWith: 'ok.', minLength: 250 },
  { name: 'long-boundary-past-window', text: LONG_BOUNDARY_PAST_WINDOW, expectHeading: null, mustEndWith: '。', maxLength: 250 },
  {
    // `maxChars: 0`: speak.ps1 replaces the text with the long-text notice (its ceiling
    // is not gated on a positive ceiling), while speak.sh skips both the guard and the
    // ceiling — the documented "macOS 0 = unlimited" difference. Both must say something.
    name: 'maxchars-zero-heading', text: MAXCHARS_ZERO, expectHeading: null, maxChars: 0,
    skipWindowChecks: true,
  },
  { name: 'emoji-filtered', text: EMOJI_SAMPLE, expectHeading: null, mustContain: '中文保留', mustNotContain: '😀', guardRequired: false },
]

for (const fixture of FIXTURES) {
  // Fixtures that pin the CLEANING (not the length guard) may stay under the ceiling.
  if (fixture.guardRequired === false) continue
  assert.ok(fixture.text.length > MAX_CHARS,
    `${fixture.name}: fixture must exceed the ${MAX_CHARS}-char ceiling to exercise the guard (got ${fixture.text.length})`)
}

/** Whitespace-normalized view used for assertions (the two engines clean differently). */
function normalize(value) { return value.replace(/\s+/g, ' ').trim() }
const SENTENCE_END = /[。！？；…]$|[.!?]$/

function checkContract(engine, fixture, spoken) {
  const text = normalize(spoken)
  const limit = fixture.maxChars === undefined ? MAX_CHARS : fixture.maxChars
  assert.ok(text.length > 0, `${engine}/${fixture.name}: nothing would be spoken`)
  if (fixture.expectHeading !== null) {
    assert.strictEqual(text, fixture.expectHeading,
      `${engine}/${fixture.name}: a heading must be spoken alone, got ${JSON.stringify(text.slice(0, 60))}`)
    return
  }
  if (fixture.skipWindowChecks !== true) {
    // The regression this guards: only the first line came out (~30 chars).
    assert.ok(text.length > 150,
      `${engine}/${fixture.name}: must read well past the first line, got ${text.length} chars: ${JSON.stringify(text.slice(0, 60))}`)
    assert.ok(SENTENCE_END.test(text),
      `${engine}/${fixture.name}: must stop on a sentence boundary, got ...${JSON.stringify(text.slice(-30))}`)
    assert.ok(text.length <= limit + 40,
      `${engine}/${fixture.name}: window out of range (${text.length})`)
  }
  if (fixture.mustContain) {
    assert.ok(text.includes(fixture.mustContain),
      `${engine}/${fixture.name}: missing ${JSON.stringify(fixture.mustContain)} in ${JSON.stringify(text.slice(0, 80))}`)
  }
  if (fixture.mustNotContain) {
    assert.ok(!text.includes(fixture.mustNotContain),
      `${engine}/${fixture.name}: must not contain ${JSON.stringify(fixture.mustNotContain)}`)
  }
  if (fixture.mustEndWith) {
    assert.ok(text.endsWith(fixture.mustEndWith),
      `${engine}/${fixture.name}: must end with ${JSON.stringify(fixture.mustEndWith)}, got ...${JSON.stringify(text.slice(-30))}`)
  }
  if (fixture.minLength !== undefined) {
    assert.ok(text.length >= fixture.minLength,
      `${engine}/${fixture.name}: window must be kept (>= ${fixture.minLength} chars), got ${text.length}`)
  }
  if (fixture.maxLength !== undefined) {
    assert.ok(text.length <= fixture.maxLength,
      `${engine}/${fixture.name}: must trim early (<= ${fixture.maxLength} chars), got ${text.length}`)
  }
}

// ---------------------------------------------------------------------------
// speak.ps1 — real pipeline through -DryRun (silent)
// ---------------------------------------------------------------------------
function trySpawn(command, args, options) {
  const result = spawnSync(command, args, options)
  return { ok: result.status === 0 && !result.error, error: result.error }
}

function hasPowerShell() {
  if (process.platform !== 'win32') return { ok: false, why: 'not Windows' }
  const probe = trySpawn('powershell.exe', ['-NoProfile', '-Command', 'exit 0'])
  return probe.ok ? { ok: true } : { ok: false, why: `powershell.exe probe failed${probe.error ? ` (${probe.error.code})` : ''}` }
}

function runPowerShell(fixture) {
  const file = path.join(require('os').tmpdir(), `dsh-speak-fixture-${fixture.name}.txt`)
  fs.writeFileSync(file, fixture.text, 'utf8')
  try {
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-File', file,
      '-MaxChars', String(fixture.maxChars === undefined ? MAX_CHARS : fixture.maxChars),
      '-LongTextMode', 'heading', '-DryRun', '1',
    ], { encoding: 'buffer' })
    assert.strictEqual(result.status, 0, `speak.ps1 exited ${result.status}: ${String(result.stderr)}`)
    return result.stdout.toString('utf8')
  } finally {
    fs.rmSync(file, { force: true })
  }
}

// ---------------------------------------------------------------------------
// speak.sh — run the SHIPPED Perl guard program, extracted from the script
// ---------------------------------------------------------------------------
// speak.sh — run its SHIPPED perl programs in the same order the script does
// ---------------------------------------------------------------------------
/**
 * Every `perl -CSD … '…'` program in speak.sh, classified by what it reads.
 *
 * speak.sh contains four of them (reading the input file, the length guard, the
 * markdown cleaner, the character filter) and they are NOT interchangeable: an
 * earlier version of this test extracted only the guard, so a fixture that checks
 * the CLEANING (emoji) failed on this half while passing on speak.ps1 — a test bug
 * that looked like a product bug. Each program is therefore identified by the
 * environment variable / pattern only it contains.
 *
 * Slicing from the first `perl -CSD` occurrence is not enough: the file reader's
 * invocation ends on its own line, so a slice from it to the guard's closing quote
 * swallows shell code (and still "contains" the guard text, fooling identity checks).
 */
function extractPerlPrograms() {
  const source = fs.readFileSync(sh, 'utf8')
  const programs = []
  const invocation = /perl -CSD[^\n']*'/g
  for (let match = invocation.exec(source); match !== null; match = invocation.exec(source)) {
    const from = match.index + match[0].length
    const tail = /\n[ \t]*'\)/.exec(source.slice(from))
    assert.ok(tail !== null, 'speak.sh: unterminated `perl -CSD` program')
    const program = source.slice(from, from + tail.index)
    // An invocation whose program is a one-liner on the SAME line (the input-file reader)
    // has its closing quote on a later line, so a slice from it runs into the following
    // shell statements. Such a candidate is shell code, not a program: skip it, or the
    // chosen "guard" would be a syntax error for perl instead of the real program.
    const leakedShell = /^\s*(fi|done|then|else)\s*$/m.test(program)
      || program.includes('TEXT=$(') || program.includes('CLEAN_MARKDOWN') || program.includes('DSH_SPEAK_MAX_CHARS=')
    if (leakedShell) continue
    programs.push({
      args: match[0].includes('-0pe') ? ['-CSD', '-0pe'] : match[0].includes('-pe') ? ['-CSD', '-pe'] : ['-CSD', '-e'],
      program,
    })
  }
  const byMarker = marker => programs.find(entry => entry.program.includes(marker))
  const guard = byMarker('DSH_SPEAK_MAX_CHARS')
  const cleaner = byMarker('DSH_SPEAK_CODE_BLOCKS')
  const filter = byMarker('\\p{Han}')
  assert.ok(guard, 'speak.sh: no perl program reads DSH_SPEAK_MAX_CHARS (was the length guard removed?)')
  assert.ok(cleaner, 'speak.sh: no perl program reads DSH_SPEAK_CODE_BLOCKS (was the markdown cleaner removed?)')
  assert.ok(filter, 'speak.sh: no perl program matches \\p{Han} (was the character filter removed?)')
  // Structural self-checks: a mis-slice is otherwise only visible in perl's error output.
  assert.ok(guard.program.trimStart().startsWith('my $text = do {'), 'speak.sh: the extracted guard does not start where the guard starts')
  assert.ok(guard.program.trimEnd().endsWith('print $window;'), 'speak.sh: the extracted guard does not end where the guard ends')
  assert.ok(cleaner.program.trimStart().startsWith('my $mode = $ENV{DSH_SPEAK_CODE_BLOCKS}'), 'speak.sh: the extracted cleaner does not start where the cleaner starts')
  assert.ok(filter.program.trimStart().startsWith('s/[^\\p{L}'), 'speak.sh: the extracted filter does not start where the filter starts')
  for (const { program } of [guard, cleaner, filter]) {
    // Perl source is bytes unless `use utf8` is in effect, so a Chinese literal inside a
    // PATTERN is read as Latin-1, stops matching the decoded text, and the stage silently
    // does nothing — the macOS-only "trims nothing" bug 1.8.0 shipped and `npm test` caught.
    // Comments are exempt (never compiled), so only the code part is checked.
    const codeOnly = program.split('\n').map(line => line.replace(/#.*$/, '')).join('\n')
    assert.ok(!/[^\x00-\x7F]/.test(codeOnly),
      'speak.sh: a perl program contains a non-ASCII literal in CODE — write punctuation as \\x{...} codepoint escapes (it would be read as Latin-1 and match nothing)')
  }
  return { guard, cleaner, filter }
}

function findPerl() {
  const candidates = ['perl', '/usr/bin/perl', 'C:\\Program Files\\Git\\usr\\bin\\perl.exe']
  const failures = []
  for (const candidate of candidates) {
    const probe = trySpawn(candidate, ['-e', 'exit 0'])
    if (probe.ok) return { ok: true, command: candidate }
    if (probe.error) failures.push(`${candidate} (${probe.error.code})`)
  }
  return {
    ok: false,
    why: failures.length > 0
      ? `perl probe failed: ${failures[0]}`
      : 'perl not found in PATH or the usual Git-for-Windows location',
  }
}

/**
 * The speak.sh pipeline in the script's own order, so its result is comparable to
 * `speak.ps1 -DryRun` (guard → clean → filter → ceiling):
 *   1. the length guard runs on the RAW text, and the shell only enters it when
 *      `MAX_CHARS > 0` (`speak.ps1` now carries the same condition);
 *   2. markdown cleaning (always on: CLEAN_MARKDOWN defaults to 1);
 *   3. the character filter that keeps letters/numbers/Han and drops emoji;
 *   4. the final ceiling, which the shell also gates on `MAX_CHARS > 0` — that is
 *      the documented "macOS 0 = unlimited" difference from speak.ps1.
 */
function runPerlPipeline(fixture, perl, programs) {
  const maxChars = fixture.maxChars === undefined ? MAX_CHARS : fixture.maxChars
  const env = {
    ...process.env,
    DSH_SPEAK_CODE_BLOCKS: 'smart',
    DSH_SPEAK_CODE_BLOCK_MAX_CHARS: '300',
    DSH_SPEAK_CODE_BLOCK_REPLACEMENT: 'You can see the code in our history.',
    DSH_SPEAK_READ_INLINE_CODE: '1',
    DSH_SPEAK_MAX_CHARS: String(maxChars),
  }
  const run = (stage, input) => {
    const result = spawnSync(perl, [...stage.args, stage.program], {
      input: Buffer.from(input, 'utf8'),
      env,
      encoding: 'buffer',
    })
    assert.strictEqual(result.status, 0, `speak.sh ${stage.args.join(' ')} exited ${result.status}: ${String(result.stderr)}`)
    return result.stdout.toString('utf8')
  }
  let text = fixture.text
  if (maxChars > 0 && text.length > maxChars) text = run(programs.guard, text)
  text = run(programs.cleaner, text)
  text = run(programs.filter, text)
  if (maxChars > 0 && text.length > maxChars) text = '本次播报内容较长，请自行阅读。'
  return text
}

// ---------------------------------------------------------------------------
let ran = 0
const skipped = []
const powershell = hasPowerShell()
if (powershell.ok) {
  for (const fixture of FIXTURES) {
    checkContract('speak.ps1', fixture, runPowerShell(fixture))
    console.log(`speak.ps1  ${fixture.name}: ok ✓`)
    ran++
  }
} else {
  skipped.push(`speak.ps1 (${powershell.why})`)
}

const perl = findPerl()
if (perl.ok) {
  const programs = extractPerlPrograms()
  for (const fixture of FIXTURES) {
    checkContract('speak.sh', fixture, runPerlPipeline(fixture, perl.command, programs))
    console.log(`speak.sh   ${fixture.name}: ok ✓`)
    ran++
  }
} else {
  skipped.push(`speak.sh (${perl.why})`)
}

if (ran === 0) {
  // Capturing a child process's output through a pipe is impossible in some
  // sandboxes (the child cannot open the pipe), so this suite can be unable to
  // run even though the engines are fine. Report it loudly instead of passing
  // silently, and instead of failing a checkout it cannot judge.
  console.log('WARNING: could not exercise any engine here — ' + skipped.join(', ')
    + '. Run this from a normal terminal to check the length guard.')
} else {
  if (skipped.length > 0) console.log(`skipped: ${skipped.join(', ')}`)
  console.log('ALL PASS ✓')
}
