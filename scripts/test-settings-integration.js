// test-settings-integration.js — verify the Host-side settings wiring against
// the REAL @deepseek-ai/dsh-settings + schemastery (from the DSH installation).
// Loads speech-hook.js, provides a minimal Cordis ctx with a working `settings`
// service (an installSettingsSection-compatible fake), fires events, and checks
// that (a) the namespace registers, (b) a settings write propagates into the
// plugin's cfg (onChange → engine re-resolution + switches take effect).
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const os = require('os')

// --- resolve real dsh-settings + schemastery from the DSH installation ----
const dshProfilesNodeModules = path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'node_modules')
if (process.env.NODE_PATH) process.env.NODE_PATH += path.delimiter + dshProfilesNodeModules
else process.env.NODE_PATH = dshProfilesNodeModules
require('module').Module._initPaths()

// --- capture announced texts ----------------------------------------------
const announced = []
const origWrite = fs.writeFileSync
fs.writeFileSync = (file, text, enc) => {
  if (String(file).includes('dsh-speech-') && String(file).endsWith('.txt')) announced.push(String(text))
  return origWrite.call(fs, file, text, enc)
}
const cp = require('child_process')
cp.spawn = () => ({ on() {} })

// --- build a ctx with a real installSettingsSection-backed settings service --
// We cannot mount the full SettingsProvider here, but installSettingsSection
// only needs ctx.inject to deliver a `settings` object with register() that
// stores (ns, schema, options) and a scope-like watcher. We replicate the
// provider's resolution contract: register resolves schema(defaults ← base ←
// user section) immediately, and the scope.get()/watch() pair lets the plugin
// observe committed user-layer writes.
const settingsRegistrations = new Map()
const settingsService = {
  register(ns, schema, options) {
    const entry = {
      ns, schema, options,
      base: options.base || {},
      userSection: {},
      resolved: schema({ ...(options.base || {}) }),
    }
    settingsRegistrations.set(ns, entry)
    return {
      get: () => entry.resolved,
      watch(cb) { entry.watch = cb },
    }
  },
  // simulate a user-layer commit (what settings.update() would do)
  commit(ns, patch) {
    const entry = settingsRegistrations.get(ns)
    if (!entry) return
    entry.userSection = { ...entry.userSection, ...patch }
    entry.resolved = entry.schema({ ...entry.base, ...entry.userSection })
    if (entry.watch) entry.watch()
  },
}

let installed = false
const ctx = {
  fiber: { state: 0 }, // FIBER_PENDING — not unloading/disposed
  inject(services, cb) {
    if (services.includes('settings')) cb({ settings: settingsService, effect: (fn) => fn() })
  },
  effect() {},
}
const listeners = {}
ctx.on = (name, cb) => { listeners[name] = cb }

// --- load plugin (settings registration happens on apply) ------------------
const hook = require(path.join(__dirname, '..', 'adapters', 'dsh', 'speech-hook.js'))
hook.apply(ctx, {
  announceTurnEnd: true, // patch sets it on; UI later turns it off to prove onChange
})

setTimeout(async () => {
  try {
    // (a) namespace registered
    const reg = settingsRegistrations.get('dsh-speak')
    assert.ok(reg, 'dsh-speak namespace must be registered with the settings service')
    console.log('namespace registered: dsh-speak')

    // the plugin's registration resolved defaults + base (patch config) already
    const resolvedAtMount = reg.resolved
    console.log('resolved at mount:', JSON.stringify(resolvedAtMount))
    assert.strictEqual(resolvedAtMount.announceTurnEnd, true, 'patch config (base) feeds resolved value')
    assert.strictEqual(resolvedAtMount.announceTodoWrite, false, 'unset switch defaults off')
    assert.strictEqual(resolvedAtMount.enabled, true, 'master switch defaults on')

    // (b) simulate a UI write: user turns announceTurnEnd off, turns
    // announceTodoWrite on, sets maxChars
    settingsService.commit('dsh-speak', { announceTurnEnd: false, announceTodoWrite: true, maxChars: 120 })

    // the plugin's cfg should now reflect the UI values
    fire('turn/end', { turn: 1, reason: { kind: 'completed' } }) // should NOT announce (off now)
    fire('todo/write', { todos: [{ status: 'completed' }, { status: 'pending' }] }) // should announce (on now)
    fire('command/done', { kind: 'success' }) // still off → no announce

    await new Promise((r) => setTimeout(r, 50))
    console.log('announced after UI write:', JSON.stringify(announced))
    assert.ok(!announced.includes('第 1 轮对话完成'), 'turn/end disabled by UI write')
    assert.ok(announced.includes('待办已更新：1/2 完成'), 'todo/write enabled by UI write')

    // (c) master switch off via UI → NOTHING announces, even enabled events
    const countBefore = announced.length
    settingsService.commit('dsh-speak', { enabled: false })
    fire('turn/end', { turn: 5, reason: { kind: 'completed' } })
    fire('todo/write', { todos: [{ status: 'completed' }] })
    fire('command/done', { kind: 'error' })
    fire('assistant/message', { surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '总开关关闭' }] } } })
    await new Promise((r) => setTimeout(r, 80))
    console.log('master switch off → delta =', announced.length - countBefore)
    assert.strictEqual(announced.length, countBefore, 'master switch off stops ALL announcements')
    console.log('ALL PASS ✓')
    process.exit(0)
  } catch (e) {
    console.error('FAIL:', e.message)
    process.exit(1)
  }
}, 300)

function fire(type, data) {
  const cb = listeners['session/event']
  if (cb) cb(null, { type, data })
}
