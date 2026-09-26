// test-manifest.js — publish-time invariants for the package manifest.
// ==============================================================================
// `npm publish` ships the working tree filtered by `files`, and every path the
// manifest points at has to exist or the published plugin cannot be installed.
// These checks are cheap and catch what a reviewer would otherwise read by hand:
//
//   * `engines.dsh` is the ONLY field dsh-market reads the host requirement from
//     (`{registry}/<pkg>/latest` → `engines.dsh`, or lockstep `@deepseek-ai/dsh*`
//     peers; other `@deepseek-ai/*` peers are ignored on purpose). Missing or
//     wrong, the catalog card reads "host requirement undeclared" or claims a
//     compatibility that does not hold, so the floor is asserted here and both
//     READMEs must state the same string.
//   * `main` / `exports` / `files[]` must resolve inside the tree.
//   * the bundle patch must register the id/name the profile entry uses, and the
//     `test` chain must not point at a renamed script.
'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
/** The DSH floor this release was verified against — move it only after testing. */
const HOST_RANGE = '>=0.1.7-rc.2'

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

assert.strictEqual(pkg.name, 'dsh-speak', 'package name must stay dsh-speak')
assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version), `version must be plain semver, got ${pkg.version}`)
console.log(`package.json: ${pkg.name}@${pkg.version} ✓`)

// --- host requirement -------------------------------------------------------
assert.ok(pkg.engines && typeof pkg.engines === 'object', 'engines block is missing')
assert.strictEqual(pkg.engines.node, '>=18', 'engines.node')
assert.strictEqual(pkg.engines.dsh, HOST_RANGE,
  `engines.dsh must stay "${HOST_RANGE}" — it is the only field dsh-market reads for the host badge`)
console.log(`engines.dsh: ${pkg.engines.dsh} ✓`)

for (const readme of ['README.md', 'README.zh-CN.md']) {
  const text = fs.readFileSync(path.join(root, readme), 'utf8')
  assert.ok(text.includes(HOST_RANGE),
    `${readme} must state the host floor ${HOST_RANGE} — docs and engines.dsh move together`)
  console.log(`${readme}: states the host floor ✓`)
}

// --- dsh manifest -----------------------------------------------------------
assert.strictEqual(pkg.dsh.bundle.patch, './cordis.patch.yml', 'dsh.bundle.patch')
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
// The entry id is the settings namespace on DSH >= 0.1.7, and the browser half
// binds it — it must match the id the client's SETTINGS_NAMESPACES lists first.
assert.ok(/id:\s*dsh-speak/.test(patch), 'cordis.patch.yml must register id: dsh-speak')
assert.ok(/name:\s*dsh-speak/.test(patch), 'cordis.patch.yml must register name: dsh-speak')
const client = fs.readFileSync(path.join(root, 'client', 'client.js'), 'utf8')
const namespaces = client.match(/const SETTINGS_NAMESPACES = \[([^\]]*)\]/)
assert.ok(namespaces, 'client/client.js must declare SETTINGS_NAMESPACES')
assert.strictEqual(namespaces[1].match(/'([^']+)'/g).map(quoted => quoted.replace(/'/g, ''))[0], 'dsh-speak',
  "the client's first settings namespace must be the entry id this patch registers")
// The pre-1.8.2 entry id stays accepted so an existing profile keeps its page.
assert.ok(/'speech-hook'/.test(namespaces[1]), 'the legacy speech-hook entry id must stay accepted')

// Two rows, one shape — and the shape is load-bearing, not cosmetic. DSH's config
// editor rewrites a `config` in place only on a TOP-LEVEL row; a `config` nested in
// the `insert` row (what 1.8.2 shipped first, and what 1.8.x profiles carry) is
// accepted by the settings page, applied to the running plugin, and then rolled
// back on disk — the option silently reverts on the next boot. Shipping both rows
// makes the first UI write persist. See the comment inside cordis.patch.yml.
// `\r?` tolerates a core.autocrlf=true checkout: this file arrives CRLF there
// and .gitattributes pins LF only for *.sh, so the row assertion must not care.
assert.ok(/^ {4}- id: dsh-speak$/m.test(patch),
  'cordis.patch.yml must keep the insert row that provides the entry')
assert.ok(/^- id: dsh-speak$/m.test(patch),
  'cordis.patch.yml must keep the editable TOP-LEVEL dsh-speak row')
assert.ok(/- id: dsh-speak\r?\n {2}name: dsh-speak\r?\n {2}config:/m.test(patch),
  'the top-level dsh-speak row must carry the `config` the settings page edits')
console.log('dsh.bundle.patch: entry + editable settings row, dsh-speak ✓')

assert.strictEqual(pkg.dsh.client.platform, 'web', 'dsh.client.platform')
assert.deepStrictEqual(pkg.dsh.client.inject,
  ['@deepseek-ai/dsh-client-ui-chat', '@deepseek-ai/dsh-client-ui-settings'],
  'dsh.client.inject must stay the two slots the browser half registers into')
assert.deepStrictEqual(pkg.dsh.client.external,
  ['@deepseek-ai/dsh-client-ui-primitives'],
  'dsh.client.external must stay the primitives package the bundle expects the host to provide')
console.log('dsh.client: platform / inject / external ✓')

// --- shipped paths ----------------------------------------------------------
for (const entry of pkg.files) {
  assert.ok(fs.existsSync(path.join(root, entry)), `files[] entry missing from the tree: ${entry}`)
}
for (const target of [pkg.main, ...Object.values(pkg.exports)]) {
  assert.ok(fs.existsSync(path.join(root, target)), `main/exports target missing: ${target}`)
}
console.log(`files/exports: ${pkg.files.length} packed entries, all present ✓`)

const chained = [...pkg.scripts.test.matchAll(/node (scripts\/[\w.-]+\.js)/g)].map(match => match[1])
assert.ok(chained.length >= 5, `test chain looks truncated: ${pkg.scripts.test}`)
for (const file of new Set(chained)) {
  assert.ok(fs.existsSync(path.join(root, file)), `test chain references a missing file: ${file}`)
}
console.log(`test chain: ${new Set(chained).size} scripts present ✓`)

console.log('ALL PASS ✓')
