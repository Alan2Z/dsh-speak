// test-client-bundle.js — smoke + contract test for the dsh-speak browser bundle.
// ==============================================================================
// Evaluates client/client.js exactly as DSH's client module system does
// (window.__ModuleLoader__.load → factory(require) → apply(ctx)), then renders
// both registered components against the DSH 0.1.7 slot contract to verify:
//
//   * the bundle registers under the id DSH's boot graph row expects
//   * apply() registers the per-message Speak action
//     (conversation.chat.assistant-actions) and the Settings → dsh-speak page
//     (settings.section, registered through configForms.whileServed)
//   * the Speak action resolves the clicked message through the Chat target
//     selector hook `useChat` — NOT through `useSession`, whose SessionSnapshot
//     stopped carrying Conversation target data in DSH 0.1.2
//   * clicking posts the exact /dsh-speak/control payload (play/stop)
//   * the button degrades to disabled (never throws) when the message is
//     unknown or the framework supplies no Chat target hook
//   * the settings page binds the configForms entry the host serves and writes
//     through form.set(field, value)
//
// No build step and no external test runner: plain Node + a hand-written React
// hook stub (the plugin only uses createElement/useState/useEffect).
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const vm = require('vm')

const NS = 'dsh-speak'
const bundlePath = path.join(__dirname, '..', 'client', 'client.js')
const code = fs.readFileSync(bundlePath, 'utf8')
assert.ok(code.includes('window.__ModuleLoader__.load({'), 'bundle must register via __ModuleLoader__.load')

// ---------------------------------------------------------------------------
// React stub: elements are plain { type, props } objects we can walk, and the
// three hooks the bundle uses keep positional state so a component can be
// rendered repeatedly (each render resets the hook cursor).
// ---------------------------------------------------------------------------
let hookState = []
let hookIndex = 0
function resetHooks() { hookState = []; hookIndex = 0 }
function element(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
}
const React = {
  createElement: element,
  Fragment: Symbol('Fragment'),
  memo: component => component,
  useState(initial) {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial
    return [hookState[index], next => { hookState[index] = typeof next === 'function' ? next(hookState[index]) : next }]
  },
  useEffect() { hookIndex++ },
  useRef(initial) {
    const index = hookIndex++
    if (!(index in hookState)) hookState[index] = { current: initial }
    return hookState[index]
  },
  useCallback(fn) { hookIndex++; return fn },
  useMemo(fn) { hookIndex++; return fn() },
}

// ---------------------------------------------------------------------------
// Primitives stub: renders the same shapes the bundle consumes, keeping
// props.children so the tree stays walkable (the wrapper components pass their
// content through these primitives).
// ---------------------------------------------------------------------------
const primitives = {
  Button: props => ({ type: 'Button', props }),
  DisclosureRow: props => ({ type: 'DisclosureRow', props }),
  // DSH 0.1.7 renamed the fixed-size icon exports: <Name>16 → <Name>Regular.
  IconPauseOutlineRegular: () => null,
  Input: props => ({ type: 'Input', props }),
}

/** Depth-first collect every element whose `type` matches. */
function findAll(node, type, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) { for (const child of node) findAll(child, type, found); return found }
  if (node.type === type) found.push(node)
  findAll(node.props && node.props.children, type, found)
  return found
}
/** First element whose `type` matches. */
function findOne(node, type) { return findAll(node, type)[0] }
/**
 * Expand the element tree the way React would: a function `type` is a
 * component (the plugin's own Field/Toggle/SettingInput wrappers and the
 * primitives stub), a string `type` is a leaf we can inspect. Hooks keep the
 * single positional cursor across the walk, matching a real render pass.
 */
function expand(node) {
  if (!node || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  if (node.props && node.props.children !== undefined) return { ...node, props: { ...node.props, children: expand(node.props.children) } }
  return node
}

// ---------------------------------------------------------------------------
// Client service stubs
// ---------------------------------------------------------------------------
/** @param served settings namespaces the Host serves (the page binds the first match). */
function makeHarness(served = ['dsh-speak']) {
  const registrations = []
  const settingsWrites = []
  const controlRequests = []
  const sockets = []
  const dictionaries = {}

  let injecting = null
  const slots = {
    inject(name, register) {
      const previous = injecting
      injecting = name
      try {
        const disposer = register()
        registrations.push({ injected: name, disposer })
      } finally { injecting = previous }
    },
    register(options, component) {
      registrations.push({ injected: injecting, options, component })
      return { options }
    },
  }

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
  // DSH >= 0.1.7 settings surface: one shared describe mirror, `get(entryId)`
  // forms over it, and `whileServed` as the "register only while the Host
  // serves this namespace" watch the page rides.
  const settingsBindings = []
  const configForms = {
    get(entryId) {
      settingsBindings.push(entryId)
      return {
        getSnapshot: () => scopeSnapshot,
        subscribe: () => () => {},
        // The real ConfigForm.set resolves to the Host's answer (true = accepted);
        // the card warns on false, so the stub must answer like the framework.
        set: async (field, value) => { settingsWrites.push({ field, value }); scopeSnapshot.value[field] = value; return true },
        unset: async field => { settingsWrites.push({ field, unset: true }); return true },
      }
    },
    describe() { return { getSnapshot: () => ({ view: { namespaces: served.map(ns => ({ ns })) } }), subscribe: () => () => {}, ensure: () => Promise.resolve() } },
    whileServed(namespaces, register) {
      const available = new Set(namespaces.filter(name => served.includes(name)))
      if (available.size === 0) return () => {}
      const off = register(available)
      return () => { if (typeof off === 'function') off() }
    },
  }

  const locale = {
    register(ns, dict) { dictionaries[ns] = dict },
    // Real binding follows the ACTIVE locale; the stub pins zh so assertions
    // read the shipped Chinese copy.
    bind(ns) { return key => { const dict = dictionaries[ns] || {}; const zh = dict.zh || {}; return zh[key] !== undefined ? zh[key] : key } },
  }

  const effect = fn => { if (typeof fn === 'function') { const dispose = fn(); if (typeof dispose === 'function') return dispose } return () => {} }

  const ctx = {
    effect,
    // The browser `timer` service mixes lifecycle-safe helpers (timeout /
    // interval / throttle / debounce) onto the context; the bundle uses
    // `ctx.timeout` for the websocket reconnect.
    timer: { timeout() { return () => {} } },
    timeout() { return () => {} },
    slots,
    configForms,
    locale,
  }

  const sandbox = {
    window: { __ModuleLoader__: { load(registration) { sandbox.loaded = registration } } },
    document: {
      createElement: () => ({ dataset: {}, textContent: '', appendChild() {}, remove() {} }),
      head: { appendChild() {} },
      querySelector: () => null,
    },
    location: { protocol: 'http:', host: 'localhost:3080' },
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    WebSocket: function WebSocketStub() { this.close = () => {}; sockets.push(this) },
    fetch: (url, init) => {
      controlRequests.push({ url, body: JSON.parse(init.body) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ type: 'speech-state', speaking: false, sessionId: null, turn: null, messageId: null, source: null, queueLength: 0 }) })
    },
    require: spec => {
      if (spec === 'react' || spec === 'react/jsx-runtime') return React
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      return require(spec)
    },
    module: { exports: {} },
    exports: {},
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox)

  return { sandbox, ctx, registrations, settingsWrites, controlRequests, sockets, settingsBindings }
}

// ---------------------------------------------------------------------------
// Chat target fixture shaped like DSH 0.1.7's ChatSnapshot
// (nodes = ChatNodeStore with values(); the finalized assistant content lives in
// data.finalNode for an assistant node and data.closing.finalNode for a
// turn-tail node).
// ---------------------------------------------------------------------------
const FINAL_TEXT = '这是最终回复。'
function assistantFinal(messageId, turn, text) {
  return { kind: 'assistant', seq: 9, messageId, time: 1, turn, step: 1, blocks: [{ kind: 'text', text }] }
}
const chatSnapshot = {
  nodes: {
    values: () => [
      // streaming assistant row without a final node — must be skipped
      { key: 'a1', kind: 'assistant', data: { status: 'running', turn: 4, step: 1, blocks: [{ kind: 'text', text: '部分' }] } },
      { key: 'a2', kind: 'assistant', data: { status: 'settled', turn: 4, step: 1, blocks: [{ kind: 'text', text: FINAL_TEXT }], finalNode: assistantFinal('m-1', 4, FINAL_TEXT) } },
      { key: 't1', kind: 'turn-tail', data: { turn: 4, seq: 10, time: 2, closing: { status: 'settled', turn: 4, step: 1, blocks: [{ kind: 'text', text: FINAL_TEXT }], finalNode: assistantFinal('m-1', 4, FINAL_TEXT) } } },
      { key: 't2', kind: 'turn-tail', data: { turn: 5, seq: 20, time: 3, closing: null } },
    ],
  },
}
/** Framework-supplied Chat target selector hook. */
const useChat = selector => selector(chatSnapshot)

// ---------------------------------------------------------------------------
// 1. bundle registration + apply()
// ---------------------------------------------------------------------------
const harness = makeHarness()
const loaded = harness.sandbox.loaded
assert.ok(loaded, 'bundle must call __ModuleLoader__.load')
assert.strictEqual(loaded.id, 'dsh-speak', 'bundle id must be dsh-speak')

const mod = loaded.factory(harness.sandbox.require)
assert.strictEqual(typeof mod.apply, 'function', 'factory must export apply')
assert.ok(Array.isArray(mod.inject), 'factory must export inject array')
console.log('exports.inject =', JSON.stringify(mod.inject))
// Every declared service must exist in DSH 0.1.7's client tree; a missing one
// parks the fiber in `pending` and fails the whole page boot (which is exactly
// how 0.1.7 broke this plugin: `settingsScope` was replaced by `configForms`).
for (const service of ['slots', 'timer', 'configForms', 'locale']) {
  assert.ok(mod.inject.includes(service), `inject must declare ${service}`)
  assert.ok(service in harness.ctx, `client ctx must provide ${service}`)
}
assert.ok(!mod.inject.includes('settingsScope'), 'settingsScope no longer exists in DSH >= 0.1.7')
assert.strictEqual(harness.sockets.length, 0, 'sockets only open inside apply()')

mod.apply(harness.ctx)
assert.strictEqual(harness.sockets.length, 1, 'apply() opens the speech-state websocket')

const speakEntry = harness.registrations.find(entry => entry.options && entry.options.name === 'conversation.chat.assistant-actions' && entry.options.id === 'speak')
assert.ok(speakEntry, 'must register the Speak message action')
assert.strictEqual(speakEntry.injected, 'conversation.chat.assistant-actions', 'must inject the slot before registering')
assert.strictEqual(speakEntry.options.order, 5, 'stable ordering among message actions')
assert.strictEqual(speakEntry.options.locale, NS, 'locale namespace for the action copy')
console.log('Speak message action registered (conversation.chat.assistant-actions) ✓')

const settingsEntry = harness.registrations.find(entry => entry.options && entry.options.name === 'settings.section' && entry.options.id === 'speak')
assert.ok(settingsEntry, 'must register the Settings → dsh-speak settings page')
assert.strictEqual(settingsEntry.injected, 'settings.section', 'must inject the slot before registering')
assert.strictEqual(typeof settingsEntry.options.label, 'function', 'settings nav label is a localized thunk')
assert.deepStrictEqual(harness.settingsBindings, [NS], 'configForms form bound to the served dsh-speak entry')
console.log('Settings → dsh-speak settings page registered (settings.section) ✓')

// The page follows the Host: an upgraded profile whose row still carries the
// pre-1.8.2 entry id binds that namespace instead, and a deployment that serves
// neither shows no page at all.
function pageFor(served) {
  const probe = makeHarness(served)
  probe.sandbox.loaded.factory(probe.sandbox.require).apply(probe.ctx)
  return probe
}
const legacy = pageFor(['speech-hook'])
assert.deepStrictEqual(legacy.settingsBindings, ['speech-hook'], 'the legacy speech-hook entry id still binds')
assert.ok(legacy.registrations.some(entry => entry.options && entry.options.name === 'settings.section'),
  'the settings page still registers under the legacy entry id')
const unserved = pageFor(['something-else'])
assert.deepStrictEqual(unserved.settingsBindings, [], 'an unknown namespace binds no form')
assert.ok(!unserved.registrations.some(entry => entry.options && entry.options.name === 'settings.section'),
  'no namespace served → no dead settings page')
console.log('Settings page follows the Host-served entry id ✓')

/** Render one component with a fresh hook cursor, expanding nested components. */
function render(component, props) { resetHooks(); return expand(component(props)) }

// ---------------------------------------------------------------------------
// 2. Speak action: 0.1.5 owner + session standard props
// ---------------------------------------------------------------------------
const speakProps = { messageId: 'm-1', sessionId: 'session-x', useChat }
const speakTree = render(speakEntry.component, speakProps)
const speakButton = findOne(speakTree, 'button')
assert.ok(speakButton, 'Speak action renders a button')
assert.strictEqual(speakButton.props['aria-label'], '播报此回合', 'idle label is the localized speak copy')
assert.strictEqual(speakButton.props.disabled, false, 'a message with text is replayable')

speakButton.props.onClick()
assert.strictEqual(harness.controlRequests.length, 1, 'click posts one control request')
assert.strictEqual(harness.controlRequests[0].url, '/dsh-speak/control', 'control route path')
assert.deepStrictEqual(harness.controlRequests[0].body,
  { action: 'play', sessionId: 'session-x', turn: 4, messageId: 'm-1', text: FINAL_TEXT },
  'play payload carries the clicked message, its turn, and the text from useChat')
console.log('Speak action resolves the clicked message through useChat ✓')

// ---------------------------------------------------------------------------
// 3. Speak action: stop state from the authoritative host WebSocket state
// ---------------------------------------------------------------------------
harness.sockets[0].onmessage({ data: JSON.stringify({ type: 'speech-state', speaking: true, sessionId: 'session-x', turn: 4, messageId: 'm-1', source: 'manual', queueLength: 0 }) })
const speakingTree = render(speakEntry.component, speakProps)
const stopButton = findOne(speakingTree, 'button')
assert.strictEqual(stopButton.props['aria-label'], '停止播报', 'a speaking turn offers Stop')
assert.strictEqual(stopButton.props['aria-pressed'], true, 'pressed state follows the host state')
stopButton.props.onClick()
assert.deepStrictEqual(harness.controlRequests[1].body, { action: 'stop' }, 'stop posts the bare stop action')
console.log('Speak action mirrors the host speech state over the websocket ✓')

// ---------------------------------------------------------------------------
// 4. Speak action: degradation instead of crashing the row
// ---------------------------------------------------------------------------
const unknownTree = render(speakEntry.component, { ...speakProps, messageId: 'nope' })
assert.strictEqual(findOne(unknownTree, 'button').props.disabled, true, 'an unknown message is not replayable')

const noHookTree = render(speakEntry.component, { messageId: 'm-1', sessionId: 'session-x' })
assert.strictEqual(findOne(noHookTree, 'button').props.disabled, true, 'missing useChat degrades to disabled, never throws')
console.log('Speak action degrades safely without a Chat target or message ✓')

// ---------------------------------------------------------------------------
// 5. Settings page
// ---------------------------------------------------------------------------
const settingsTree = render(settingsEntry.component, { close() {} })
const toggle = findOne(settingsTree, 'Button')
assert.ok(toggle, 'settings page renders its controls')
assert.strictEqual(toggle.props.children, '开', 'boolean settings render as localized On/Off')
toggle.props.onClick()
assert.deepStrictEqual(harness.settingsWrites[0], { field: 'enabled', value: false }, 'the master switch writes through the configForms form')
const numericInput = findOne(settingsTree, 'Input')
assert.ok(numericInput, 'numeric settings render a text input')
assert.strictEqual(typeof numericInput.props.onChange, 'function', 'inputs accept change handling')
console.log('Settings page renders and writes through configForms ✓')

console.log('ALL PASS ✓')
