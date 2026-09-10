// test-engine-static.js — publish-time invariants for the engine scripts.
// ==============================================================================
// Three regressions have already reached users through these files, so they are
// checked mechanically instead of trusted to review:
//
//   * issue #3 (fixed in 1.7.2, regressed once more in 1.7.4): PowerShell 5.1
//     parses a BOM-less `.ps1` with the ANSI code page. The engine's literals
//     (the default LongTextMessage, the voice-matching hints) then become
//     mojibake and speech can fail silently. Every engine .ps1 must start with
//     the UTF-8 BOM — any tool that rewrites the file tends to drop it.
//   * issue 6.7 in docs/DESIGN.md: `speak.sh` with CRLF dies in bash on macOS
//     (`command not found`, `syntax error near {`) and `npm pack` ships the
//     WORKING TREE, so a CRLF checkout publishes a broken macOS engine. Every
//     engine .sh must stay LF-only.
//   * a PowerShell PARSER error is invisible to `node --check` and to every
//     other check here, yet it makes the engine abort before speaking anything.
//     One real example: PowerShell treats “ ” ‘ ’ as string delimiters too, so
//     writing a smart quote inside a single-quoted literal silently truncates it
//     (`Missing ')' in method call`). The parser is therefore asked directly.
//
// The parser half needs to spawn powershell.exe; when that is impossible (no
// Windows, or a sandbox that blocks creating the child's pipes) it is skipped
// with a loud warning rather than a failure it cannot justify.
'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const engineDir = path.join(__dirname, '..', 'engine')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])

const files = fs.readdirSync(engineDir).sort()
assert.ok(files.length > 0, 'engine/ must not be empty')

for (const name of files) {
  const file = path.join(engineDir, name)
  const bytes = fs.readFileSync(file)

  if (name.endsWith('.ps1')) {
    assert.ok(bytes.subarray(0, 3).equals(BOM),
      `${name}: missing UTF-8 BOM — Windows PowerShell 5.1 would read the literals with the ANSI code page (issue #3). ` +
      'Restore it with: [System.IO.File]::WriteAllText($f, [System.IO.File]::ReadAllText($f, [Text.Encoding]::UTF8), (New-Object Text.UTF8Encoding($true)))')
    console.log(`${name}: UTF-8 BOM present ✓`)
  }

  if (name.endsWith('.sh')) {
    const crlf = bytes.includes(Buffer.from('\r\n'))
    const strayCr = !crlf && bytes.includes(0x0d)
    assert.ok(!crlf && !strayCr,
      `${name}: contains CR — bash on macOS dies on a CRLF script (issue 6.7). Keep *.sh text eol=lf (see .gitattributes).`)
    console.log(`${name}: LF-only ✓`)
  }
}

// ---------------------------------------------------------------------------
// PowerShell parse check — every engine .ps1 must parse cleanly.
// ---------------------------------------------------------------------------
const PARSE_COMMAND = [
  '$failed = $false',
  '$tokens = $null',
  'foreach ($f in Get-ChildItem -LiteralPath $env:DSH_ENGINE_DIR -Filter *.ps1) {',
  '  $errors = $null',
  '  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors) | Out-Null',
  '  foreach ($e in $errors) { $failed = $true; Write-Output ("PARSE ERROR " + $f.Name + ": " + $e.Message) }',
  '}',
  'if (-not $failed) { Write-Output "PARSE OK" } else { exit 1 }',
].join('\n')

function probePowerShell() {
  if (process.platform !== 'win32') return { ok: false, why: 'not Windows' }
  const probe = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0'])
  return probe.status === 0 && !probe.error
    ? { ok: true }
    : { ok: false, why: `powershell.exe probe failed${probe.error ? ` (${probe.error.code})` : ''}` }
}

const powershell = probePowerShell()
if (powershell.ok) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PARSE_COMMAND], {
    env: { ...process.env, DSH_ENGINE_DIR: engineDir },
    encoding: 'utf8',
  })
  const output = (result.stdout || '').trim()
  assert.ok(result.status === 0 && !/PARSE ERROR/.test(output),
    `engine/ has a PowerShell syntax error (invisible to node --check):\n${output || result.stderr}`)
  console.log('engine/*.ps1: parse clean ✓')
} else {
  console.log(`engine/*.ps1: parse check SKIPPED (${powershell.why}) — run this from a normal terminal`)
}

console.log('ALL PASS ✓')
