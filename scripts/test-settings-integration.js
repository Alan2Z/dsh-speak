// test-settings-integration.js — verify the Host-side settings wiring against
// the REAL @deepseek-ai/schemastery (from the DSH installation) and the real
// Config-projection contract DSH >= 0.1.7 uses.
// ==============================================================================
// 0.1.7 replaced `settings.register(namespace, schema, { base })` with Config
// projection: the settings service reads every active Loader entry's own
// exported `Config` and projects its `.volatile()` fields into the settings UI.
// This test pins that contract end to end without booting dsh:
//
//   * the module exports a static `Config` schema and nothing calls the deleted
//     `settings.register` API any more,
//   * every field in SCHEMA_DEFAULTS is a volatile field of that schema (a field
//     the form shows but the schema lacks would make the write fail with
//     `Config field "x" is not volatile`; a volatile field SCHEMA_DEFAULTS lacks
//     would never reach cfg),
//   * the Loader hands volatile fields over as references (`config.x.get()`) and
//     a live commit arrives as `loader/volatile-update` — the plugin must follow
//     the new values AND still accept a plain config object (no schema),
//   * the master switch silences everything, including after a live write.
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const cp = require('child_process')
const { EventEmitter } = require('events')

// Resolve schemastery from the DSH installation.
const dshNM = 'E:\\apps\\nvm\\v25.8.0\\node_modules\\@deepseek-ai\\dsh\\node_modules'
if (process.env.NODE_PATH) process.env.NODE_PATH += path.delimiter + dshNM
else process.env.NODE_PATH = dshNM
require('module').Module._initPaths()

// Capture spoken text (temp files only, not the diagnostic log).
const announced = []
const origWrite = fs.writeFileSync
fs.writeFileSync = (file, text, enc) => {
  if (typeof file === 'string' && file.includes('dsh-speech-') && file.endsWith('.txt') && !file.includes('hook.log')) {
    announced.push(String(text))
  }
  return origWrite.call(fs, file, text, enc)
}
// Mock spawn: EventEmitter so the queue's settle() can fire.
const spawned = []
cp.spawn = (cmd, args, opts) => {
  const child = new EventEmitter()
  child.pid = 4242
  child.kill = () => { child.emit('exit', 0); return true }
  spawned.push(child)
  return child
}

const hookPath = path.join(__dirname, '..', 'adapters', 'dsh', 'speech-hook.js')
// Regression guard for the 0.1.2 and 0.1.7 breaks. Prose ABOUT the removed
// helpers is fine (the plugin documents them), so the guards run over code with
// comments stripped — only real usage is a defect.
const hookSource = fs.readFileSync(hookPath, 'utf8')
const hookCode = hookSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1')
assert.ok(!/require\(\s*['"]@deepseek-ai\/dsh-settings['"]\s*\)/.test(hookCode),
  'plugin must not require @deepseek-ai/dsh-settings — it deleted the helpers the plugin used to call')
assert.ok(!/\.installSettingsSection\s*\(/.test(hookCode) && !/\.settingsNamespace\s*\(/.test(hookCode),
  'plugin must not call the helpers removed in DSH 0.1.2')
assert.ok(!/\.settings\.register\s*\(/.test(hookCode),
  'plugin must not call settings.register — DSH 0.1.7 replaced it with Config projection')

const hook = require(hookPath)

// ---------------------------------------------------------------------------
// 1. the exported schema IS the settings form
// ---------------------------------------------------------------------------
const z = require('@deepseek-ai/schemastery')
assert.ok(hook.Config, 'plugin must export a Config schema for the settings service to project')
assert.strictEqual(typeof hook.Config.toJSON, 'function', 'Config must be a schemastery schema')

// The settings service hydrates the serialized schema and keeps its volatile
// fields — the exact walk dsh-settings' volatileForm() performs.
const hydrated = new z(hook.Config.toJSON())
assert.strictEqual(hydrated.type, 'object', 'settings form root is an object')
const schemaFields = Object.keys(hydrated.dict || {})
const nonVolatile = schemaFields.filter(key => !(hydrated.dict[key].meta && hydrated.dict[key].meta.volatile))
assert.deepStrictEqual(nonVolatile, [], 'every settings field must be volatile to be editable live')
console.log(`Config schema: ${schemaFields.length} volatile fields ✓`)

// SCHEMA_DEFAULTS must not drift from the schema: it is the normalization
// fallback (and the documented surface) for exactly these fields.
const defaultsBlock = hookSource.match(/const SCHEMA_DEFAULTS = \{([\s\S]*?)\n\}/)
assert.ok(defaultsBlock, 'SCHEMA_DEFAULTS must exist as a literal')
const defaultKeys = [...defaultsBlock[1].matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*):/gm)].map(match => match[1])
assert.deepStrictEqual(defaultKeys.slice().sort(), schemaFields.slice().sort(),
  'SCHEMA_DEFAULTS and the exported Config schema must describe the same fields')
console.log(`SCHEMA_DEFAULTS matches the schema (${defaultKeys.length} keys) ✓`)

// The option list lives in three places — the Config schema (the form), the
// READMEs' option tables (the documentation) and SCHEMA_DEFAULTS (checked above).
// A field added to one and forgotten in another is how a "setting that does
// nothing" ships, so pin the docs down too.
for (const readme of ['README.md', 'README.zh-CN.md']) {
  const text = fs.readFileSync(path.join(__dirname, '..', readme), 'utf8')
  const documented = [...new Set([...text.matchAll(/^\| `([A-Za-z][A-Za-z0-9]*)` \|/gm)].map(match => match[1]))].sort()
  assert.ok(documented.length > 0, `${readme}: option table not found`)
  assert.deepStrictEqual(documented, schemaFields.slice().sort(),
    `${readme}: the option table and the Config schema must list the same fields`)
  console.log(`${readme}: ${documented.length} documented options match the schema ✓`)
}

// ---------------------------------------------------------------------------
// 2. the Loader contract: references, live commits, plain-config fallback
// ---------------------------------------------------------------------------
const WRITE = Symbol.for('cosmokit.volatile.write')

/** Minimal Cordis ctx: session events, volatile updates, and both injections. */
function makeCtx() {
  const listeners = {}
  const disposers = []
  const ctx = {
    fiber: { state: 2, entry: { options: { id: 'dsh-speak' } } },
    on(name, cb) { (listeners[name] = listeners[name] || []).push(cb) },
    inject(services, cb) {
      if (services.includes('settings')) {
        const settings = { auto: null, configure(presentation) { this.auto = presentation.auto; return () => {} } }
        ctx.__settings = settings
        cb({ settings, effect: fn => fn() })
      }
      if (services.includes('webServer')) cb({ webServer: { registerUpgrade: () => () => {}, register: () => () => {} }, effect: fn => fn() })
    },
    effect(fn) {
      const dispose = fn ? fn() : undefined
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    baseUrl: __filename,
  }
  ctx.__fire = (name, ...args) => { for (const cb of listeners[name] || []) cb(...args) }
  ctx.__event = (type, data) => ctx.__fire('session/event', null, { type, data, surfaceOp: type === 'assistant/message' ? 'append' : undefined })
  ctx.__volatile = () => ctx.__fire('loader/volatile-update', [])
  /** Simulate fiber disposal: run every registered effect disposer in reverse. */
  ctx.__dispose = () => { while (disposers.length > 0) { const dispose = disposers.pop(); try { dispose() } catch (e) { /* ignore */ } } }
  return ctx
}
async function finishAll(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    const current = spawned.splice(0, spawned.length)
    if (current.length === 0) break
    current.forEach((ch) => ch.emit('exit', 0))
    await new Promise((r) => setTimeout(r, 10))
  }
  spawned.length = 0
}
/** Validate a patch through the REAL schema, exactly as resolveConfig does. */
function validated(patch) {
  const result = hook.Config['~standard'].validate(patch)
  assert.strictEqual(result.issues, undefined, `config rejected: ${JSON.stringify(result.issues)}`)
  return result.value
}
/** Commit a settings write the way the Loader does: in place, then notify. */
function commitVolatile(config, patch) {
  const candidate = validated(patch)
  for (const key of Object.keys(patch)) {
    const target = config[key]
    assert.ok(target && typeof target.get === 'function', `${key} must be handed to apply() as a reference`)
    target[WRITE](candidate[key].get())
  }
}
/** Raw current values out of the references (what a Host describe returns). */
function rawOf(config) {
  return Object.fromEntries(Object.entries(config).map(([key, value]) => [key, value.get()]))
}

const live = validated({ announceTurnEnd: true, throttleMs: 10 })
const ctx = makeCtx()
hook.apply(ctx, live)

setTimeout(async () => {
  try {
    // (a) the entry opts out of the shell's automatically generated page — it
    // owns a hand-written one in the browser half.
    assert.ok(ctx.__settings, 'the plugin must reach the settings service')
    assert.strictEqual(ctx.__settings.auto, false, 'dsh-speak owns a custom page, so auto generation is off')
    console.log('settings presentation: auto page disabled for the custom dsh-speak page ✓')

    // (b) patch config feeds the resolved values
    const resolvedAtMount = rawOf(live)
    console.log('resolved at mount:', JSON.stringify({ announceTurnEnd: resolvedAtMount.announceTurnEnd, announceTodoWrite: resolvedAtMount.announceTodoWrite, enabled: resolvedAtMount.enabled, throttleMs: resolvedAtMount.throttleMs }))
    assert.strictEqual(resolvedAtMount.announceTurnEnd, true, 'patch config feeds the reference value')
    assert.strictEqual(resolvedAtMount.announceTodoWrite, false, 'unset switch defaults off')
    assert.strictEqual(resolvedAtMount.enabled, true, 'master switch defaults on')
    assert.strictEqual(resolvedAtMount.queueAllMessages, false, 'queueAllMessages defaults off')

    // (c) live UI write: turn announceTurnEnd off, todo on, maxChars down
    commitVolatile(live, { announceTurnEnd: false, announceTodoWrite: true, maxChars: 120 })
    ctx.__volatile()

    ctx.__event('turn/end', { turn: 1, reason: { kind: 'completed' } }) // should NOT announce (off now)
    ctx.__event('todo/write', { todos: [{ status: 'completed' }, { status: 'pending' }] }) // should announce
    ctx.__event('command/done', { kind: 'success' }) // still off → no announce

    await new Promise((r) => setTimeout(r, 20))
    await finishAll()
    console.log('announced after the live write:', JSON.stringify(announced))
    assert.ok(!announced.includes('第 1 轮对话完成'), 'turn/end disabled by the live write')
    assert.ok(announced.includes('待办已更新：1/2 完成'), 'todo/write enabled by the live write')
    console.log('loader/volatile-update applies a settings edit without a restart ✓')

    // (d) master switch off via the UI → NOTHING announces
    const countBefore = announced.length
    commitVolatile(live, { enabled: false })
    ctx.__volatile()
    ctx.__event('turn/end', { turn: 5, reason: { kind: 'completed' } })
    ctx.__event('todo/write', { todos: [{ status: 'completed' }] })
    ctx.__event('command/done', { kind: 'error' })
    ctx.__event('assistant/message', { turn: 6, step: 1, message: { content: [{ type: 'text', text: '总开关关闭' }] } })
    await new Promise((r) => setTimeout(r, 60))
    await finishAll()
    console.log('master switch off → delta =', announced.length - countBefore)
    assert.strictEqual(announced.length, countBefore, 'master switch off stops ALL announcements')
    console.log('master switch (live) silences everything ✓')

    // (e) a second row for the same plugin must stay inert: two live instances
    // would double-announce and fight over the `/dsh-speak/ws` route. The claim is
    // released when the owning fiber disposes, so a later instance can take over.
    announced.length = 0
    const duplicateCtx = makeCtx()
    hook.apply(duplicateCtx, validated({ announceTodoWrite: true, throttleMs: 10 }))
    duplicateCtx.__event('todo/write', { todos: [{ status: 'completed' }, { status: 'pending' }] })
    await new Promise((r) => setTimeout(r, 20))
    await finishAll()
    assert.deepStrictEqual(announced, [], 'a duplicate entry must not run a second speech queue')
    console.log('duplicate entry stays inert ✓')

    ctx.__dispose()                       // the owner's fiber goes away…
    const takeoverCtx = makeCtx()
    hook.apply(takeoverCtx, validated({ announceTodoWrite: true, throttleMs: 10 }))
    takeoverCtx.__event('todo/write', { todos: [{ status: 'completed' }, { status: 'pending' }] })
    await new Promise((r) => setTimeout(r, 20))
    await finishAll()
    assert.deepStrictEqual(announced, ['待办已更新：1/2 完成'], 'the claim is released on dispose, so a remaining row takes over')
    console.log('single-instance claim released on dispose ✓')

    // (f) no schema at all (schemastery unavailable, or a host that passes the
    // raw patch config): plain values must keep working unchanged.
    announced.length = 0
    takeoverCtx.__dispose()
    const plainCtx = makeCtx()
    hook.apply(plainCtx, { announceTodoWrite: true, throttleMs: 10 })
    plainCtx.__event('todo/write', { todos: [{ status: 'completed' }, { status: 'pending' }] })
    await new Promise((r) => setTimeout(r, 20))
    await finishAll()
    assert.deepStrictEqual(announced, ['待办已更新：1/2 完成'], 'a plain config object still drives the queue')
    console.log('plain (schema-less) config still works ✓')

    console.log('ALL PASS ✓')
    process.exit(0)
  } catch (e) {
    console.error('FAIL:', e.message)
    process.exit(1)
  }
}, 300)
