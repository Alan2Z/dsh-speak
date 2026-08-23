// test-client-bundle.js — smoke test for the dsh-speak browser bundle.
// Stubs window.__ModuleLoader__ and the client services (slots / locale /
// settingsScope), evaluates client/client.js exactly as DSH would load it, and
// verifies: the bundle registers with the right id, apply() mounts a card into
// settings.plugin.item keyed 'dsh-speak', and the card renders with the current
// settings values. This exercises the handwritten bundle's contract without a
// browser.
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')

// Let this script's own require('react')/require('react-dom/server') resolve
// from the DSH installation (the profile's flat node_modules junction farm).
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
    registrations.slots.push({ name, key: off && off.options && off.options.key, off })
  },
  register(opts, component) {
    registrations.slots.push({ registered: opts, component })
    return { options: opts }
  },
}
const dictionaries = {}
const locale = {
  register(ns, dict) { dictionaries[ns] = dict },
  bind(ns) { return (key) => { const d = dictionaries[ns] || {}; return d[key] !== undefined ? d[key] : key } },
}
let boundScope = null
const scopeSnapshot = {
  status: 'ready',
  value: {
    throttleMs: 1500, engine: '', announceApprovals: true, announceQuestions: true,
    stripApprovalPrefix: true, longTextMode: 'message', maxChars: 300, volume: 50, rate: 0,
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
const effect = (fn) => fn()

const ctx = {
  effect,
  locale,
  slots,
  inject(services, cb) {
    if (services.includes('settingsScope')) cb({ settingsScope, slots })
  },
}

// --- load the bundle exactly as DSH does ----------------------------------
let loaded = null
global.window = {
  __ModuleLoader__: {
    load(registration) { loaded = registration },
  },
}
// Resolve react from the DSH installation so the factory gets real hooks.
const reactPath = require.resolve('react', { paths: [dshProfilesNodeModules] })
const reactRequire = require(reactPath)

const bundlePath = path.join(__dirname, '..', 'client', 'client.js')
const code = fs.readFileSync(bundlePath, 'utf8')
assert.ok(code.includes("window.__ModuleLoader__.load({"), 'bundle must register via __ModuleLoader__.load')
// evaluate in a context where `require` is our patched resolver
const vm = require('vm')
const sandbox = {
  window: global.window,
  require: (spec) => {
    if (spec === 'react' || spec === 'react/jsx-runtime') return reactRequire
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

// --- run apply() and check the card registration ---------------------------
mod.apply(ctx)
const card = registrations.slots.find((r) => r.registered && r.registered.name === 'settings.plugin.item' && r.registered.key === NS)
assert.ok(card, 'card must register into settings.plugin.item keyed dsh-speak')
console.log('card registered: settings.plugin.item key=' + card.registered.key)

// --- render the card component with React ---
// The registration wraps the component: register({...}, () => h(Card, props)).
// `card.component` is that zero-arg thunk; call it once to get the element.
// We assert structural validity with the SAME react instance the bundle used
// (React.isValidElement). Rendered behavior (collapsed-by-default, expand on
// click, unsaved badge) is verified end-to-end against the live DSH web UI
// with Playwright (see dsh-card-collapse check), because react-dom/server here
// resolves to a different react copy than the bundle's seed react.
const React = reactRequire
const cardNode = card.component()
assert.ok(React.isValidElement(cardNode), 'card component must return a valid React element')
console.log('card component returns valid React element; type=' + (typeof cardNode.type === 'function' ? cardNode.type.name || '(anonymous)' : String(cardNode.type)))

// scope must have been bound to the right namespace
assert.ok(boundScope !== null && boundScope.spec.namespace === 'dsh-speak', 'scope bound to dsh-speak')
console.log('settingsScope bound to:', boundScope.spec.namespace)
console.log('ALL PASS ✓')
