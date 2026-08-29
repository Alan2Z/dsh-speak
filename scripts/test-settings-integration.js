// test-settings-integration.js — verify the Host-side settings wiring against
// the REAL @deepseek-ai/dsh-settings + schemastery (from the DSH installation),
// with the merged (1.7.0) queue architecture.
// Mocks a minimal Cordis ctx (timer / webServer / settings), loads
// speech-hook.js, and checks that (a) the namespace registers, (b) a settings
// write propagates into the plugin's cfg, (c) the master switch silences
// everything when turned off via settings.
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const cp = require('child_process')
const { EventEmitter } = require('events')

// Resolve dsh-settings + schemastery from the DSH installation.
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

// --- settings service (replicates the provider resolution contract) ---
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
  commit(ns, patch) {
    const entry = settingsRegistrations.get(ns)
    if (!entry) return
    entry.userSection = { ...entry.userSection, ...patch }
    entry.resolved = entry.schema({ ...entry.base, ...entry.userSection })
    if (entry.watch) entry.watch()
  },
}

// --- minimal Cordis ctx ---
const listeners = {}
const ctx = {
  fiber: { state: 0 },
  on(name, cb) { listeners[name] = cb },
  inject(services, cb) {
    if (services.includes('timer')) cb({ timer: { timeout: (fn) => { try { fn() } catch (e) { console.error('timer err:', e.message) } } }, effect: (fn) => fn() })
    if (services.includes('settings')) cb({ settings: settingsService, effect: (fn) => fn() })
    if (services.includes('webServer')) cb({ webServer: { registerUpgrade: () => () => {}, register: () => () => {} }, effect: (fn) => fn() })
  },
  effect() {},
  baseUrl: __filename,
}
function fire(type, payload) {
  const cb = listeners['session/event']
  if (cb) cb(null, { type, data: payload, surfaceOp: type === 'assistant/message' ? 'append' : undefined })
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

// --- load plugin (settings registration happens on a timer tick) ---
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

    const resolvedAtMount = reg.resolved
    console.log('resolved at mount:', JSON.stringify(resolvedAtMount))
    assert.strictEqual(resolvedAtMount.announceTurnEnd, true, 'patch config (base) feeds resolved value')
    assert.strictEqual(resolvedAtMount.announceTodoWrite, false, 'unset switch defaults off')
    assert.strictEqual(resolvedAtMount.enabled, true, 'master switch defaults on')
    assert.strictEqual(resolvedAtMount.queueAllMessages, false, 'queueAllMessages defaults off')

    // (b) simulate a UI write: turn announceTurnEnd off, todo on, maxChars
    settingsService.commit('dsh-speak', { announceTurnEnd: false, announceTodoWrite: true, maxChars: 120 })

    fire('turn/end', { turn: 1, reason: { kind: 'completed' } }) // should NOT announce (off now)
    fire('todo/write', { todos: [{ status: 'completed' }, { status: 'pending' }] }) // should announce
    fire('command/done', { kind: 'success' }) // still off → no announce

    await new Promise((r) => setTimeout(r, 20))
    await finishAll()
    console.log('announced after UI write:', JSON.stringify(announced))
    assert.ok(!announced.includes('第 1 轮对话完成'), 'turn/end disabled by UI write')
    assert.ok(announced.includes('待办已更新：1/2 完成'), 'todo/write enabled by UI write')

    // (c) master switch off via UI → NOTHING announces
    const countBefore = announced.length
    settingsService.commit('dsh-speak', { enabled: false })
    fire('turn/end', { turn: 5, reason: { kind: 'completed' } })
    fire('todo/write', { todos: [{ status: 'completed' }] })
    fire('command/done', { kind: 'error' })
    fire('assistant/message', { turn: 6, step: 1, message: { content: [{ type: 'text', text: '总开关关闭' }] } })
    await new Promise((r) => setTimeout(r, 60))
    await finishAll()
    console.log('master switch off → delta =', announced.length - countBefore)
    assert.strictEqual(announced.length, countBefore, 'master switch off stops ALL announcements')
    console.log('ALL PASS ✓')
    process.exit(0)
  } catch (e) {
    console.error('FAIL:', e.message)
    process.exit(1)
  }
}, 300)
