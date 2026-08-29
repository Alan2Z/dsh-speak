// test-client-bundle.js — smoke test for the merged (1.7.0) dsh-speak browser
// bundle. Stubs window.__ModuleLoader__ and the client services (slots /
// settingsScope / timer), evaluates client/client.js exactly as DSH would load
// it, and verifies: the bundle registers with the right id, apply() registers
// the per-message Speak action (conversation.chat.assistant-actions) and the
// Settings → dsh-speak settings page (settings.section), and settingsScope is
// bound to the dsh-speak namespace.
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')

// Let this script's own require('react') resolve from the DSH installation.
const dshProfilesNodeModules = path.join(process.env.USERPROFILE, '.dsh', 'profiles', 'node_modules')
if (process.env.NODE_PATH) process.env.NODE_PATH += path.delimiter + dshProfilesNodeModules
else process.env.NODE_PATH = dshProfilesNodeModules
require('module').Module._initPaths()

// --- stub client services -------------------------------------------------
const registrations = { slots: [] }
const NS = 'dsh-speak'

const slots = {
  inject(name, register) {
    const off = register()
    registrations.slots.push({ name, key: off && off.options && off.options.id, off })
  },
  register(opts, component) {
    registrations.slots.push({ registered: opts, component })
    return { options: opts }
  },
}
let boundScope = null
const scopeSnapshot = {
  status: 'ready',
  value: {
    enabled: true, automaticSpeech: true, queueAllMessages: false,
    cleanMarkdownFormatting: true, readInlineCode: true, codeBlocks: 'smart',
    codeBlockMaxChars: 300, codeBlockReplacementText: 'You can see the code in our history.',
    throttleMs: 1500, engine: '', announceApprovals: true, announceQuestions: true,
    stripApprovalPrefix: true, longTextMode: 'message', longTextMessage: '本次播报内容较长，请自行阅读。',
    maxChars: 300, volume: 50, rate: 0,
    announceTurnEnd: true, announceCommandDone: false, announceGoalChange: false,
    announceToolErrors: false, announceTodoWrite: false,
  },
  base: {},
  user: { announceTurnEnd: true },
  revision: 1, writable: true, mode: 'host',
}
const settingsScope = {
  bind(spec) {
    assert.strictEqual(spec.namespace, NS, 'bind namespace must match host registration')
    boundScope = { spec }
    return {
      getSnapshot: () => scopeSnapshot,
      subscribe: (cb) => () => {},
      set: async (field, value) => { scopeSnapshot.value[field] = value },
      unset: async (field) => { delete scopeSnapshot.value[field] },
    }
  },
}
const effect = (fn) => { if (typeof fn === 'function') { const r = fn(); if (typeof r === 'function') return r; return () => {} } return () => {} }
// locale mock: register() stores dictionaries, bind() returns a lookup that
// falls back to the key (so English UI keys resolve to their zh/en values).
const dictionaries = {}
const locale = {
  register(ns, dict) { dictionaries[ns] = dict },
  bind(ns) { return (key) => { const d = dictionaries[ns] || {}; return d[key] !== undefined ? d[key] : key } },
}
const ctx = {
  effect,
  timeout() { return () => {} },
  slots,
  settingsScope, // declared inject: ['slots', 'timer', 'settingsScope', 'locale']
  locale,
}

// --- load the bundle exactly as DSH does ----------------------------------
let loaded = null
global.window = {
  __ModuleLoader__: {
    load(registration) { loaded = registration },
  },
}
const reactPath = require.resolve('react', { paths: [dshProfilesNodeModules] })
const reactRequire = require(reactPath)

const bundlePath = path.join(__dirname, '..', 'client', 'client.js')
const code = fs.readFileSync(bundlePath, 'utf8')
assert.ok(code.includes("window.__ModuleLoader__.load({"), 'bundle must register via __ModuleLoader__.load')

// Fake primitives: the bundle requires Button / DisclosureRow / IconPauseOutline16 / Input.
const fakePrimitives = {
  Button: (props) => null,
  DisclosureRow: (props) => props.children || null,
  IconPauseOutline16: () => null,
  Input: (props) => null,
}

const vm = require('vm')
const sandbox = {
  window: global.window,
  document: {
    createElement: () => ({ dataset: {}, textContent: '', appendChild() {}, remove() {} }),
    head: { appendChild() {} },
    querySelector: () => null,
  },
  location: { protocol: 'http:', host: 'localhost:3080' },
  WebSocket: function () { this.onmessage = null; this.onclose = null; this.onerror = null; this.close = () => {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  require: (spec) => {
    if (spec === 'react' || spec === 'react/jsx-runtime') return reactRequire
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives
    return require(spec)
  },
  module: { exports: {} },
  exports: {},
  console,
}
vm.createContext(sandbox)
vm.runInContext(code, sandbox)

assert.ok(loaded !== null, 'bundle must call __ModuleLoader__.load')
assert.strictEqual(loaded.id, 'dsh-speak', 'bundle id must be dsh-speak')

// factory(require) → { apply, inject }
const mod = loaded.factory(sandbox.require)
assert.strictEqual(typeof mod.apply, 'function', 'factory must export apply')
assert.ok(Array.isArray(mod.inject), 'factory must export inject array')
console.log('exports.inject =', JSON.stringify(mod.inject))

// --- run apply() and check registrations ----------------------------------
mod.apply(ctx)
const speakAction = registrations.slots.find((r) => r.registered && r.registered.name === 'conversation.chat.assistant-actions' && r.registered.id === 'speak')
assert.ok(speakAction, 'must register the Speak message action')
console.log('Speak message action registered (conversation.chat.assistant-actions) ✓')
const settingsPage = registrations.slots.find((r) => r.registered && r.registered.name === 'settings.section' && r.registered.id === 'speak')
assert.ok(settingsPage, 'must register the Settings → dsh-speak settings page')
console.log('Settings → dsh-speak settings page registered (settings.section) ✓')

// scope must have been bound to the right namespace
assert.ok(boundScope !== null && boundScope.spec.namespace === 'dsh-speak', 'scope bound to dsh-speak')
console.log('settingsScope bound to:', boundScope.spec.namespace)
console.log('ALL PASS ✓')
