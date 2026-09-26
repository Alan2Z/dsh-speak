// speech-hook.js — DSH web adapter: voice-announce assistant activity
// ==============================================================================
// Listens to the session event stream (session/event), extracts the final reply
// text, and hands it to the speech engine (engine/speak.ps1 on Windows,
// engine/speak.sh on macOS) through a hidden, non-blocking child process.
//
// Since 1.7.0 this is the merged host of the original dsh-speak behavior and
// victorwads' PR #2 (turn-level replay + host FIFO speech queue + WebSocket
// state sync + native Speak settings page):
//
//   * a host-owned FIFO speech queue: only one native speech process runs at a
//     time; queued items continue automatically when the current one finishes
//   * every eligible item (final reply, approvals, questions, optional events,
//     manual replay) is enqueued, so the WebSocket state (which message is
//     speaking, queue length) is always truthful — even for automatic replies
//   * `queueAllMessages` (default off) switches between two automatic modes:
//       - off (default): final replies are throttled/merged as before, plus the
//         optional event announcements; tool calls cancel pending narration
//       - on: every assistant/message is enqueued immediately as it arrives
//   * a `/dsh-speak/control` POST route (play/stop/status) and a
//     `/dsh-speak/ws` WebSocket publish the authoritative speech state
//   * a settings form projected from THIS module's exported `Config` (DSH >=
//     0.1.7 reads each Loader entry's own Config); schema defaults → patch
//     config → UI user layer. The settings namespace is the entry id
//     (`dsh-speak`), and a write commits into the live config references
//   * `enabled` master switch: when off, nothing is ever enqueued (no sound)
//
// Trigger semantics:
//   * assistant/message with a `text` block is announced (reasoning / tool_use
//     blocks are skipped)
//   * a tool/call to `ask_user_question` announces the parsed question; other
//     tool calls cancel the pending throttled announcement (default mode)
//   * `approval/asked` is announced immediately (reason, else a fixed prompt)
//   * optional events (turn/end, command/done, goal/change, tool/result errors,
//     todo/write) are announced when their toggle is on (default off)
//
// Configuration — prefer the Web UI (Settings → dsh-speak settings) or the
// profile patch `config` block (see README.md). All keys resolve as
// schema default → patch config → UI user layer.
'use strict'

const { spawn } = require('child_process')
const { WebSocketServer, WebSocket } = require('ws')
const fs = require('fs')
const os = require('os')
const path = require('path')

const LOG = path.join(os.tmpdir(), 'dsh-speech-hook.log')
function log(...args) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(' ')}\n`) } catch (e) { /* ignore */ }
}

const ENGINE_NAME = process.platform === 'darwin' ? 'speak.sh' : 'speak.ps1'

/**
 * Locate the engine script:
 *   1. explicit override (config `engine`)
 *   2. <this package>/engine/<speak.ps1|speak.sh> — repo checkout or profile install
 *   3. legacy file-copy location (~/.dsh/hooks/<speak.ps1|speak.sh>)
 */
function resolveEngine(override) {
  if (override) return override
  const bundled = path.join(__dirname, '..', '..', 'engine', ENGINE_NAME)
  if (fs.existsSync(bundled)) return bundled
  return path.join(os.homedir(), '.dsh', 'hooks', ENGINE_NAME)
}

// Platform-aware defaults: macOS `say` has no per-utterance ceiling, so
// `maxChars` defaults to 0 (unlimited) there; Windows keeps the safe 300.
const DEFAULT_MAX_CHARS = process.platform === 'darwin' ? 0 : 300

// ---------------------------------------------------------------------------
// Settings (DSH >= 0.1.7: this module's own exported `Config` is the form)
// ---------------------------------------------------------------------------
// 0.1.7 replaced the imperative `settings.register(namespace, schema, { base })`
// provider API with Config projection: the settings service reads every ACTIVE
// Loader entry's own exported `Config` schema and projects its `.volatile()`
// fields into the settings UI (`ctx.settings.describe()` on the host,
// `ctx.configForms` in the browser). There is no namespace to register any
// more — the namespace IS the Loader entry id (`dsh-speak`; see
// cordis.patch.yml), which is what client/client.js binds.
//
// What that changes here:
//   * the schema must exist as a static export, built at module load (the
//     Loader reads `module.exports.Config` before any context exists),
//   * volatile fields reach apply() as stable references (`config.enabled
//     .get()`), not plain values,
//   * a settings write commits into those references in place and emits
//     `loader/volatile-update` — no restart, so cfg is re-derived there.
//
// Nothing is registered from this half any more: 0.1.2-alpha.1 had deleted
// `installSettingsSection` / `settingsNamespace`, and 0.1.7 deleted the
// `settings.register` service API that had replaced them in 1.6.0. The only
// thing left to do is opt out of the shell's auto-generated page (it would
// duplicate the hand-written one in client/client.js).
//
// Values still resolve as: schema default → patch `config` → UI user layer.
// `SCHEMA_DEFAULTS` is the normalization fallback used when the schemastery
// peer is unavailable (no Config → no settings page, patch config only);
// test-settings-integration.js asserts it stays in sync with the real schema.
const SCHEMA_DEFAULTS = {
  enabled: true,
  automaticSpeech: true,
  cleanMarkdownFormatting: true,
  readInlineCode: true,
  codeBlocks: 'smart',
  codeBlockMaxChars: 300,
  codeBlockReplacementText: 'You can see the code in our history.',
  queueAllMessages: false,
  throttleMs: 1500,
  replayFullRead: false,
  engine: '',
  announceApprovals: true,
  announceQuestions: true,
  stripApprovalPrefix: true,
  questionGapMs: 2000,
  longTextMode: 'message',
  longTextMessage: '本次播报内容较长，请自行阅读。',
  maxChars: DEFAULT_MAX_CHARS,
  volume: 50,
  rate: 0,
  announceTurnEnd: false,
  announceCommandDone: false,
  announceGoalChange: false,
  announceToolErrors: false,
  announceTodoWrite: false,
}

/**
 * Coerce one numeric config field.
 *
 * An explicit value wins — including 0, which is meaningful for `throttleMs` (no
 * merging), `maxChars` (macOS: unlimited) and `volume` (silence). The fallback
 * applies only when the field is absent or unparseable, and the result is clamped
 * to what the engine accepts, because an out-of-range SAPI `Rate` (-10..10) or
 * `Volume` (0..100) makes `speak.ps1` throw — i.e. silence with no explanation.
 * `||` is deliberately NOT used here: it silently turned a user's 0 into the
 * fallback and let negatives through.
 * @param field - config key, for the clamp diagnostic.
 * @returns the usable number.
 */
function configNumber(field, value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const clamped = Math.min(max, Math.max(min, Math.round(parsed)))
  if (clamped !== parsed) log('settings 值超出范围，已钳制:', field, parsed, '->', clamped)
  return clamped
}

/**
 * Resolve the raw settings value into the mutable `cfg` the queue reads.
 * Kept a pure mapping (only a diagnostic line when a value had to be clamped) so
 * the initial apply and every `loader/volatile-update` normalize identically
 * (engine re-resolution, platform defaults, SAPI-safe ranges).
 */
function resolveConfig(value) {
  value = value || {}
  return {
    enabled: value.enabled !== false,
    automaticSpeech: value.automaticSpeech !== false,
    cleanMarkdownFormatting: value.cleanMarkdownFormatting !== false,
    readInlineCode: value.readInlineCode !== false,
    codeBlocks: ['all', 'smart', 'replace'].includes(value.codeBlocks) ? value.codeBlocks : 'smart',
    codeBlockMaxChars: configNumber('codeBlockMaxChars', value.codeBlockMaxChars, 300, 0, Number.MAX_SAFE_INTEGER),
    codeBlockReplacementText: String(value.codeBlockReplacementText || 'You can see the code in our history.'),
    queueAllMessages: value.queueAllMessages === true,
    throttleMs: configNumber('throttleMs', value.throttleMs, 1500, 0, Number.MAX_SAFE_INTEGER),
    replayFullRead: value.replayFullRead === true,
    engine: resolveEngine(value.engine || ''),
    announceApprovals: value.announceApprovals !== false,
    announceQuestions: value.announceQuestions !== false,
    stripApprovalPrefix: value.stripApprovalPrefix !== false,
    questionGapMs: configNumber('questionGapMs', value.questionGapMs, 2000, 0, Number.MAX_SAFE_INTEGER),
    longTextMode: value.longTextMode === 'heading' ? 'heading' : 'message',
    longTextMessage: String(value.longTextMessage || SCHEMA_DEFAULTS.longTextMessage),
    maxChars: configNumber('maxChars', value.maxChars, DEFAULT_MAX_CHARS, 0, Number.MAX_SAFE_INTEGER),
    volume: configNumber('volume', value.volume, 50, 0, 100),
    // Windows: SAPI scale -10..10. macOS: words per minute (0 = engine default),
    // where the engine passes -r only for a positive value anyway.
    rate: process.platform === 'darwin'
      ? configNumber('rate', value.rate, 0, 0, Number.MAX_SAFE_INTEGER)
      : configNumber('rate', value.rate, 0, -10, 10),
    announceTurnEnd: value.announceTurnEnd === true,
    announceCommandDone: value.announceCommandDone === true,
    announceGoalChange: value.announceGoalChange === true,
    announceToolErrors: value.announceToolErrors === true,
    announceTodoWrite: value.announceTodoWrite === true,
  }
}

/**
 * Read one config field from whatever shape the Loader handed us: a volatile
 * field arrives as a reference (`{ get() }`, cosmokit `createVolatile`), a
 * plugin mounted without a Config schema receives plain values, and an omitted
 * field is simply `undefined`.
 * @returns the current plain value, or undefined.
 */
function configValue(config, key) {
  if (!config) return undefined
  const value = config[key]
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object' && typeof value.get === 'function') return value.get()
  return value
}

/**
 * Detach every known field into the plain object `resolveConfig` normalizes.
 * Read fresh on each call: the references are updated in place by a settings
 * write, so the same `config` object always yields the current values.
 */
function rawConfig(config) {
  const raw = {}
  for (const key of Object.keys(SCHEMA_DEFAULTS)) raw[key] = configValue(config, key)
  return raw
}

/**
 * The settings namespace this plugin owns: its Loader entry id. That id is what
 * the settings service projects the form under (`settings.describe()` →
 * `ctx.configForms.get(id)` in the browser) and what client/client.js binds.
 * `settingsNamespace` is also the name the plugin used for its settings before
 * 0.1.7, so the browser half accepts either spelling.
 * @returns the entry id, or undefined when mounted without a Loader.
 */
function settingsNamespace(ctx) {
  try { return ctx.fiber && ctx.fiber.entry ? ctx.fiber.entry.options.id : undefined } catch (e) { return undefined }
}

/**
 * Build the settings form schema — the module's static `Config` export.
 *
 * Resolved at load time because the Loader reads `module.exports.Config`
 * immediately after importing the plugin, before any context exists (the old
 * `ctx.baseUrl` fallback is therefore unavailable here, and `__filename` is
 * enough: it walks the profile's own `node_modules` chain either way).
 * Best-effort: an installation that cannot resolve the schemastery peer gets no
 * settings page (Config stays undefined) and keeps running on the composed
 * patch `config`.
 * @returns the schema, or undefined when the peer is unavailable.
 */
function buildConfig() {
  try {
    const z = require('module').createRequire(__filename)('@deepseek-ai/schemastery')
    return z.object({
      enabled: z.boolean().default(true).volatile(),
      automaticSpeech: z.boolean().default(true).volatile(),
      cleanMarkdownFormatting: z.boolean().default(true).volatile(),
      readInlineCode: z.boolean().default(true).volatile(),
      codeBlocks: z.union(['all', 'smart', 'replace']).default('smart').volatile(),
      codeBlockMaxChars: z.natural().default(300).volatile(),
      codeBlockReplacementText: z.string().default('You can see the code in our history.').volatile(),
      queueAllMessages: z.boolean().default(false).volatile(),
      throttleMs: z.natural().default(1500).volatile(),
      replayFullRead: z.boolean().default(false).volatile(),
      engine: z.string().default('').volatile(),
      announceApprovals: z.boolean().default(true).volatile(),
      announceQuestions: z.boolean().default(true).volatile(),
      stripApprovalPrefix: z.boolean().default(true).volatile(),
      questionGapMs: z.natural().default(2000).volatile(),
      longTextMode: z.union(['message', 'heading']).default('message').volatile(),
      longTextMessage: z.string().default('本次播报内容较长，请自行阅读。').volatile(),
      maxChars: z.natural().default(DEFAULT_MAX_CHARS).volatile(),
      volume: z.natural().default(50).volatile(),
      rate: z.number().default(0).volatile(),
      announceTurnEnd: z.boolean().default(false).volatile(),
      announceCommandDone: z.boolean().default(false).volatile(),
      announceGoalChange: z.boolean().default(false).volatile(),
      announceToolErrors: z.boolean().default(false).volatile(),
      announceTodoWrite: z.boolean().default(false).volatile(),
    })
  } catch (e) {
    log('settings 依赖不可用，跳过 settings 表单（继续用 patch config）:', e && e.message)
    return undefined
  }
}

module.exports = {
  // Static settings form schema projected by the settings service (DSH >=
  // 0.1.7). Undefined when the schemastery peer cannot be resolved.
  Config: buildConfig(),

  apply(ctx, config) {
    // ---- duplicate-entry guard ----------------------------------------------
    // One profile must mount this plugin exactly ONCE. A second row with the same
    // id (or the legacy `speech-hook` id) is easy to create by accident — adding
    // `dsh-speak` to `dsh.profile.bundles` while the hand-written insert row is
    // still there is the usual way. Two live instances would mean two FIFO queues
    // announcing everything twice and two claims on the `/dsh-speak/ws` route.
    //
    // The claim is keyed on `globalThis`, not on a module variable: two rows may
    // name this file differently (a `file:///…` URL beside the bare package name)
    // and Node would then evaluate the module twice, each copy seeing its own
    // module-scope flag. The extra instance stays inert and says so in the log —
    // remove the duplicate row and reload to hand ownership over.
    //
    // This guard protects SPEECH only. A duplicated entry id also breaks the
    // settings page in a way this half cannot fix: DSH's config editor keeps only
    // uniquely-ided entries, so every write is refused with
    // `settings/rejected: Configuration for "dsh-speak" is overridden by a home
    // patch or command-line overlay` while speech keeps working. Hence the hint in
    // the log line below.
    const claim = Symbol.for('dsh-speak.active')
    if (globalThis[claim] !== undefined) {
      log('已有实例在运行，本行不再挂载（条目 id =', settingsNamespace(ctx),
        '）：请删掉重复的 dsh-speak 行后重载 —— 重复的 id 还会让设置页的写入被拒（overridden by a home patch）')
      return
    }
    globalThis[claim] = true
    ctx.effect(() => () => { if (globalThis[claim] === true) delete globalThis[claim] }, 'dsh-speak: single-instance claim')

    // Live configuration: the references inside `config` are updated in place
    // by a settings write, so cfg is re-derived from them (see below).
    const readConfig = () => resolveConfig(rawConfig(config))
    let cfg = readConfig()

    // ---- settings presentation ----------------------------------------------
    // This plugin ships a hand-written settings page (client/client.js), so the
    // entry opts out of the shell's automatically generated form — otherwise the
    // same fields would appear twice. Presentation-only and non-fatal: a host
    // without the settings service simply has no pages at all.
    ctx.inject(['settings'], scopedCtx => {
      if (!ctx.fiber) return
      try {
        scopedCtx.effect(() => scopedCtx.settings.configure({ auto: false }, ctx.fiber))
        log('settings 表单由 settings 服务投影（entry =', settingsNamespace(ctx), '，自动页面已关闭）')
      } catch (e) {
        log('settings.configure 失败，保留默认页面策略:', e && e.message)
      }
    })

    // A settings write commits into the running fiber's config references and
    // emits this event; re-deriving cfg is what makes the edit audible without
    // restarting dsh.
    ctx.on('loader/volatile-update', () => {
      try { cfg = readConfig() } catch (e) { log('settings 变更应用失败:', e && e.message) }
    })

    // ---- host-owned FIFO speech queue + WebSocket state sync (PR #2) ----
    let activeSpeech = null
    let speechToken = 0
    let replacement = null
    /** 队列项播完后的停顿定时器（多问题提问之间的间隔） */
    let gapTimer = null
    const speechQueue = []
    const speechSockets = new Set()
    const speechWss = new WebSocketServer({ noServer: true })

    function state() {
      const item = activeSpeech && activeSpeech.item
      return {
        type: 'speech-state',
        speaking: item !== undefined && item !== null,
        sessionId: item ? item.sessionId : null,
        turn: item ? item.turn : null,
        messageId: item ? item.messageId : null,
        source: item ? item.source : null,
        queueLength: speechQueue.length,
      }
    }
    function publishState() {
      const payload = JSON.stringify(state())
      for (const socket of speechSockets) {
        if (socket.readyState === WebSocket.OPEN) {
          try { socket.send(payload) } catch (e) { speechSockets.delete(socket) }
        }
      }
    }
    function removeTemp(tmp) { try { fs.unlinkSync(tmp) } catch (e) { /* already removed */ } }

    function startOne(item) {
      // master switch: nothing is ever spoken while disabled
      if (!cfg.enabled) { log('总开关关闭，跳过播报（文本长度:', item.text.length, '）'); return false }
      if (!item || !item.text.trim() || activeSpeech) return false
      const tmp = path.join(os.tmpdir(), `dsh-speech-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
      try { fs.writeFileSync(tmp, item.text, 'utf8') } catch (e) { log('write temp failed:', e.message); return false }
      log('speech start', item.source, item.sessionId || '-', item.turn == null ? '-' : item.turn, item.messageId || '-', item.text.slice(0, 80))
      let child
      // 手动重播完整朗读：replayFullRead 打开时，重播跳过 heading 截断完整朗读
      const fullRead = item.manual === true && cfg.replayFullRead === true
      if (process.platform === 'darwin') {
        const args = ['-f', tmp, '-m', String(cfg.maxChars), '-M', cfg.longTextMode, '-l', cfg.longTextMessage, '-C', cfg.cleanMarkdownFormatting ? '1' : '0', '-I', cfg.readInlineCode ? '1' : '0', '-B', cfg.codeBlocks, '-K', String(cfg.codeBlockMaxChars), '-R', cfg.codeBlockReplacementText]
        if (cfg.rate > 0) args.push('-r', String(cfg.rate))
        if (fullRead) args.push('-F')
        child = spawn('/bin/bash', [cfg.engine].concat(args), { detached: true, stdio: 'ignore' })
      } else {
        // Windows 语速 = SAPI 刻度（-10 到 10，0 = 正常；负值变慢），直接透传，
        // 不要把 0/负值替换成 1（否则无法回到正常语速/减慢）
        child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.engine, '-File', tmp, '-Volume', String(cfg.volume), '-Rate', String(cfg.rate), '-MaxChars', String(cfg.maxChars), '-LongTextMode', cfg.longTextMode, '-LongTextMessage', cfg.longTextMessage, '-CleanMarkdownFormatting', cfg.cleanMarkdownFormatting ? '1' : '0', '-ReadInlineCode', cfg.readInlineCode ? '1' : '0', '-CodeBlocks', cfg.codeBlocks, '-CodeBlockMaxChars', String(cfg.codeBlockMaxChars), '-CodeBlockReplacementText', cfg.codeBlockReplacementText, '-FullRead', fullRead ? '1' : '0'], { windowsHide: true, stdio: 'ignore' })
      }
      const token = ++speechToken
      activeSpeech = { process: child, tmp, token, item, gapMs: item.gapMs || 0 }
      publishState()
      const settle = () => {
        removeTemp(tmp)
        if (!activeSpeech || activeSpeech.token !== token) return
        const gap = activeSpeech.gapMs || 0
        activeSpeech = null
        publishState()
        const proceed = () => {
          gapTimer = null
          if (replacement) {
            const next = replacement
            replacement = null
            startOne(next)
          } else {
            startNext()
          }
        }
        // 队列项之间可配置停顿（如多个提问之间留 2 秒）
        if (gap > 0) {
          gapTimer = setTimeout(proceed, gap)
        } else {
          proceed()
        }
      }
      child.once('exit', settle)
      child.once('error', settle)
      return true
    }
    function startNext() {
      if (activeSpeech || replacement) return
      const item = speechQueue.shift()
      if (!item) { publishState(); return }
      publishState()
      startOne(item)
    }
    function enqueue(item) {
      if (!item || !item.text || !item.text.trim()) return
      speechQueue.push(item)
      publishState()
      startNext()
    }
    function stopActive() {
      const active = activeSpeech
      if (!active) return false
      try {
        if (process.platform === 'darwin' && active.process.pid) process.kill(-active.process.pid, 'SIGTERM')
        else active.process.kill()
      } catch (e) { log('stop speech failed:', e.message) }
      return true
    }
    function clearAndStop() {
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null }
      speechQueue.length = 0
      publishState()
      return stopActive()
    }
    function replaceWith(item) {
      if (gapTimer) { clearTimeout(gapTimer); gapTimer = null }
      speechQueue.length = 0
      replacement = item
      publishState()
      if (!activeSpeech) {
        const next = replacement
        replacement = null
        startOne(next)
        return
      }
      stopActive()
    }
    function visibleText(message) {
      if (!message) return ''
      if (typeof message.content === 'string') return message.content
      if (!Array.isArray(message.content)) return ''
      return message.content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
    }
    function hostItem(source, session, event, text, messageId) {
      const sessionValue = session && (session.id != null ? session.id : session.sessionId)
      return {
        source,
        sessionId: sessionValue != null ? String(sessionValue) : null,
        turn: event && event.data && Number.isFinite(event.data.turn) ? event.data.turn : null,
        messageId: messageId == null ? null : String(messageId),
        text,
      }
    }

    // ---- WebSocket + control route (PR #2) ----
    ctx.inject(['webServer'], webCtx => {
      webCtx.effect(() => webCtx.webServer.registerUpgrade({
        path: '/dsh-speak/ws',
        handler: (req, socket, head) => speechWss.handleUpgrade(req, socket, head, client => {
          speechSockets.add(client)
          client.once('close', () => speechSockets.delete(client))
          client.once('error', () => speechSockets.delete(client))
          try { client.send(JSON.stringify(state())) } catch (e) { speechSockets.delete(client) }
        }),
      }), 'dsh-speak speech-state websocket')
      webCtx.effect(() => webCtx.webServer.register({
        kind: 'exact', path: '/dsh-speak/control', handler: async (req, res) => {
          const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)) }
          if (req.method !== 'POST' || !String(req.headers['content-type'] || '').startsWith('application/json')) { reply(405, { error: 'POST application/json required' }); return }
          try {
            const chunks = []; let size = 0
            for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('request too large'); chunks.push(chunk) }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            if (body.action === 'status') { reply(200, state()); return }
            if (body.action === 'stop') {
              replacement = null
              clearAndStop()
              reply(200, state())
              return
            }
            if (body.action !== 'play' || typeof body.text !== 'string' || !body.text.trim()) { reply(400, { error: 'invalid control request' }); return }
            replaceWith({ source: 'manual', manual: true, sessionId: body.sessionId == null ? null : String(body.sessionId), turn: Number.isFinite(body.turn) ? body.turn : null, messageId: body.messageId == null ? null : String(body.messageId), text: body.text })
            reply(200, state())
          } catch (e) { reply(e.message === 'request too large' ? 413 : 400, { error: e.message }) }
        },
      }), 'dsh-speak replay control route')
    })

    ctx.effect(() => () => {
      replacement = null
      clearAndStop()
      for (const socket of speechSockets) { try { socket.close() } catch (e) { /* closed */ } }
      speechSockets.clear()
      try { speechWss.close() } catch (e) { /* closed */ }
    }, 'dsh-speak speech cleanup')

    // ---- session event handling ----
    let timer = null
    let pendingText = ''
    /** 当前回合内最后一条助手消息文本（turn/end 兜底播报用） */
    let lastText = ''
    /** 已通过节流播报过的文本（防止 turn/end 兜底重复播报） */
    let lastSpokenText = ''
    /** 最后一条助手消息 id（兜底播报时带上） */
    let lastMessageId = null
    /** cancel a pending throttled announcement (default mode, tool-call round) */
    function cancelPending() {
      if (timer) { clearTimeout(timer); timer = null }
      pendingText = ''
    }

    ctx.on('session/event', (session, event) => {
      try {
        const type = event && event.type
        if (type !== 'assistant/chunk') {
          log('事件 type=', type, 'surfaceOp=', event && event.surfaceOp, 'seq=', event && event.seq)
        }
        // 新回合开始：清空上一回合的兜底状态，避免跨回合残留
        if (type === 'turn/start') {
          cancelPending()
          lastText = ''
          lastSpokenText = ''
          lastMessageId = null
          return
        }
        // tool-call round: ask_user_question announces the parsed question; any
        // other tool call cancels the pending throttled narration
        if (type === 'tool/call') {
          if (event.data && event.data.name === 'ask_user_question' && cfg.announceQuestions) {
            let items = []
            try {
              const args = JSON.parse(event.data.arguments || '{}')
              const questions = Array.isArray(args.questions) ? args.questions : []
              // 每个问题单独入队播报：带"问题N"序号（多问题时）与"选项N"序号
              // （序号用数字，与 UI 的自动编号一致；中文 TTS 自然读成"一/二/三"）
              items = questions.map((question, qi) => {
                const mode = question.multi_select ? '多选' : '单选'
                const opts = Array.isArray(question.options) ? question.options : []
                const optText = opts.map((option, oi) => {
                  const label = option && option.label ? String(option.label) : ''
                  return label ? `选项${oi + 1}，${label}` : ''
                }).filter(Boolean).join('；')
                const head = questions.length > 1 ? `问题${qi + 1}，` : ''
                // question 文案已含"单选/多选"字样时不再追加模式后缀，避免重复
                const modeSuffix = /单选|多选/.test(question.question || '') ? '' : `（${mode}）`
                const body = [question.question || '', modeSuffix, optText ? '，' + optText : ''].join('')
                return (head + body).trim()
              }).filter(Boolean)
            } catch (e) { /* ignore malformed arguments */ }
            if (items.length > 0) {
              cancelPending()
              // 问题已单独播报，标记当前最后文本为已播，避免 turn/end 兜底重复
              lastSpokenText = lastText
              // 多条问题按 FIFO 串行播报，之间停顿 cfg.questionGapMs（默认 2 秒）
              const gap = cfg.questionGapMs > 0 && items.length > 1 ? cfg.questionGapMs : 0
              items.forEach((itemText, i) => {
                const item = hostItem('question', session, event, itemText, null)
                item.gapMs = i < items.length - 1 ? gap : 0
                enqueue(item)
              })
            }
            return
          }
          cancelPending()
          return
        }
        // approval requested: announce right away
        if (type === 'approval/asked' && cfg.announceApprovals) {
          cancelPending()
          let reason = String((event.data && event.data.reason) || '')
          if (cfg.stripApprovalPrefix) {
            // 通用剥离行首"动作标签: "前缀（英文动作短语 + 冒号，如
            // "Store decision fact in workspace memory (dsh-speak): <内容>"、
            // "escalate sandbox to danger-full-access: <原因>"），只念冒号后的
            // 具体内容；中文开头或无冒号的 reason 原样保留（如"删除 xxx"）。
            reason = reason.replace(/^[A-Za-z][^:：\n]*?[:：]\s*/, '').trim()
          }
          enqueue(hostItem('approval', session, event, reason || '需要你的审批，请查看界面。', null))
          return
        }
        // 回合结束：兜底播报最终回复（被工具调用取消的节流文本在此补播，
        // 已播过的不重复），随后按需播报"第 N 轮对话完成"可选事件
        if (type === 'turn/end') {
          if (cfg.automaticSpeech && !cfg.queueAllMessages && lastText && lastText !== lastSpokenText) {
            const itemText = lastText
            const itemMessageId = lastMessageId
            cancelPending()
            lastText = ''
            lastSpokenText = itemText
            enqueue(hostItem('automatic', session, event, itemText, itemMessageId))
          }
          if (!cfg.announceTurnEnd) return
          const data = event.data
          const prefix = data && data.turn != null ? `第 ${data.turn} 轮对话` : '本轮对话'
          const kind = data && data.reason && data.reason.kind
          const text = ({ completed: prefix + '完成', aborted: prefix + '中断', interrupted: prefix + '中断', blocked: prefix + '被阻塞', error: prefix + '异常结束', 'max-tokens': prefix + '异常结束' })[kind] || prefix + '结束'
          enqueue(hostItem('turn/end', session, event, text, null))
          return
        }
        if (type === 'command/done' && cfg.announceCommandDone) {
          enqueue(hostItem('command/done', session, event, (event.data && event.data.kind) === 'error' ? '命令执行失败' : '命令执行完成', null))
          return
        }
        if (type === 'goal/change' && cfg.announceGoalChange) {
          const data = event.data
          const objective = data && data.goal && data.goal.objective
          const label = ({ create: '已创建目标', edit: '目标已更新', complete: '目标已完成', pause: '目标已暂停', resume: '目标已恢复', block: '目标已阻塞', clear: '目标已清除' })[data && data.operation] || '目标状态变化'
          const text = objective && ['create', 'edit', 'complete'].includes(data.operation) ? `${label}：${objective.replace(/\s+/g, ' ').trim().slice(0, 40)}` : label
          enqueue(hostItem('goal/change', session, event, text, null))
          return
        }
        if (type === 'tool/result' && cfg.announceToolErrors) {
          const data = event.data
          const err = data && data.error
          // 真实错误标记有两处：结构化失败身份 data.error（name/code），以及结果块上的
          // isError。0.1.2 起 createToolResultMessage 把结果块包进一个 ToolResultBlock
          // （{ type:'tool-result', toolCallId, content:[…], isError }），文字在它嵌套的
          // content 里；更早的版本把 isError 直接放在 text 块上。两种形状都读。
          //
          // 注意：pwsh / bash 把「命令非零退出」当作结果数据上报（`exit code: N`），
          // 不置 isError —— 只有基础设施失败（spawn 错误、abort）才是 isError 结果，
          // 所以失败的命令本身不会播报工具出错。
          const errText = (Array.isArray(data && data.message && data.message.content) ? data.message.content : [])
            .filter(block => block && block.isError === true)
            .map(block => {
              const parts = Array.isArray(block.content) ? block.content : [block]
              return parts.map(part => (part && (part.text || part.code)) || '').filter(Boolean).join(' ')
            })
            .filter(Boolean).join(' ')
          if (err || errText) {
            const detail = (errText || (err && err.code) || (err && err.name) || '').replace(/\s+/g, ' ').trim().slice(0, 60)
            // 详情只在"确实是一句中文描述"时才念：英文模板（Error: / ENOENT / 技术
            // code）对中文用户可读性差，应当截掉。判据是**汉字数量多于拉丁字母数量**，
            // 而不是"含有汉字"——后者会被路径里的中文目录名骗过：
            // `Error: cannot read "D:\...\第二轮测试用的不存在文件.txt"` 含 12 个汉字，
            // 却是纯英文报错（1.8.0 修正）。
            const cjkCount = (detail.match(/[\u4e00-\u9fff]/g) || []).length
            const latinCount = (detail.match(/[A-Za-z]/g) || []).length
            const readable = cjkCount > latinCount ? `：${detail}` : ''
            enqueue(hostItem('tool/result', session, event, `工具调用出错${readable}`, null))
          }
          return
        }
        if (type === 'todo/write' && cfg.announceTodoWrite) {
          const todos = Array.isArray(event.data && event.data.todos) ? event.data.todos : []
          const done = todos.filter(t => t && t.status === 'completed').length
          enqueue(hostItem('todo/write', session, event, `待办已更新：${done}/${todos.length} 完成`, null))
          return
        }
        if (!event || type !== 'assistant/message') return
        if (event.surfaceOp && event.surfaceOp !== 'append') return
        const message = event.data && (event.data.message || event.data)
        const text = visibleText(message)
        if (!text.trim()) return

        // queueAllMessages mode (PR #2): enqueue every assistant message now
        if (cfg.queueAllMessages && cfg.automaticSpeech) {
          enqueue(hostItem('automatic', session, event, text, message && message.id))
          return
        }
        // default mode: throttle/merge the final reply; a tool/call cancels it,
        // and turn/end 兜底补播 lastText（见上方 turn/end 分支）
        cancelPending()
        pendingText = text
        lastText = text
        lastMessageId = message && message.id ? String(message.id) : null
        timer = setTimeout(() => {
          if (!pendingText) return
          const itemText = pendingText
          pendingText = ''
          timer = null
          lastSpokenText = itemText
          enqueue(hostItem('automatic', session, event, itemText, lastMessageId))
        }, cfg.throttleMs)
      } catch (e) { log('session event speech error:', e.message) }
    })
  },
}
