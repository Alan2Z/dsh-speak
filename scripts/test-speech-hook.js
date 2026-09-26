// test-speech-hook.js — smoke test for the merged (1.7.0) event announcements
// and the two automatic modes (default throttled final reply + queueAllMessages).
// Mocks a minimal Cordis ctx (timer / webServer / session events), loads
// speech-hook.js, and asserts the announced texts. The speech queue is async:
// each item spawns a child whose 'exit' advances the queue, so the mock spawn
// returns an EventEmitter we can fire to simulate completion.
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const cp = require('child_process')
const { EventEmitter } = require('events')

// Route NODE_PATH to the DSH installation so `ws` and schemastery resolve.
const dshNM = 'E:\\apps\\nvm\\v25.8.0\\node_modules\\@deepseek-ai\\dsh\\node_modules'
if (process.env.NODE_PATH) process.env.NODE_PATH += path.delimiter + dshNM
else process.env.NODE_PATH = dshNM
require('module').Module._initPaths()

// Capture spoken text via fs.writeFileSync; the queue writes a temp file per
// item before spawning the engine.
const announced = []
const origWrite = fs.writeFileSync
fs.writeFileSync = (file, text, enc) => {
  // only capture speech temp files (dsh-speech-<ts>-<rand>.txt), NOT the
  // diagnostic log (dsh-speech-hook.log) which also matches 'dsh-speech-'
  if (typeof file === 'string' && file.includes('dsh-speech-') && file.endsWith('.txt') && !file.includes('hook.log')) {
    announced.push(String(text))
  }
  return origWrite.call(fs, file, text, enc)
}

// Mock spawn: return an EventEmitter so the queue's settle() (exit) can fire.
const spawned = []
cp.spawn = (cmd, args, opts) => {
  const child = new EventEmitter()
  child.pid = 4242
  child.kill = () => { child.emit('exit', 0); return true }
  spawned.push({ cmd, args, child })
  return child
}

// --- minimal Cordis ctx factory (fresh listeners per scenario) ---
function makeCtx() {
  const listeners = {}
  const disposers = []
  const ctx = {
    on(name, cb) { listeners[name] = cb },
    inject(services, cb) {
      // timer: register settings namespace on a tick
      if (services.includes('timer')) cb({ timer: { timeout: (fn) => { try { fn() } catch (e) { /* settings deps may be absent */ } } }, effect: (fn) => fn() })
      // webServer: register ws upgrade + control route
      if (services.includes('webServer')) {
        cb({
          webServer: {
            registerUpgrade: ({ handler }) => { ctx.__wsHandler = handler; return () => {} },
            register: ({ path, handler }) => { ctx.__routes = ctx.__routes || {}; ctx.__routes[path] = handler; return () => {} },
          },
          effect: (fn) => fn(),
        })
      }
    },
    effect(fn) {
      const dispose = fn ? fn() : undefined
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    baseUrl: __filename,
  }
  ctx.__fire = (type, data) => { if (listeners['session/event']) listeners['session/event'](null, { type, data }) }
  // event payload is { type, data: <payload> }; data carries turn/step/message
  ctx.__fireEvent = (type, payload) => { if (listeners['session/event']) listeners['session/event'](null, { type, data: payload, surfaceOp: 'append' }) }
  /** Simulate fiber disposal — each scenario is its own mount of the plugin. */
  ctx.__dispose = () => { while (disposers.length > 0) { const dispose = disposers.pop(); try { dispose() } catch (e) { /* ignore */ } } }
  return ctx
}

const hook = require(path.join(__dirname, '..', 'adapters', 'dsh', 'speech-hook.js'))

// Every scenario mounts the plugin fresh, so the previous mount's fiber is disposed
// first: the host half claims single-instance ownership and would otherwise leave the
// following scenarios inert (which is exactly what the guard is for).
let mounted = null
function applyWith(config) {
  announced.length = 0
  spawned.length = 0
  if (mounted) mounted.__dispose()
  const ctx = makeCtx()
  mounted = ctx
  hook.apply(ctx, config)
  return {
    fire(type, data) { ctx.__fire(type, data) },
    fireEvent(type, payload) { ctx.__fireEvent(type, payload) },
    get __routes() { return ctx.__routes },
    async flush(n = 50) { await new Promise(r => setTimeout(r, n)) },
    // complete every spawned child (fire exit) to advance the queue;
    // the queue is serial: finishing one spawn may spawn the next, so loop
    // until no new child appears and the queue has drained.
    async finishAll(rounds = 10) {
      for (let i = 0; i < rounds; i++) {
        const current = spawned.splice(0, spawned.length)
        if (current.length === 0) break
        current.forEach(({ child }) => { child.emit('exit', 0) })
        await new Promise(r => setTimeout(r, 10))
      }
      spawned.length = 0
    },
  }
}

// ---------------------------------------------------------------------------
// Platform-aware engine expectations. The queue spawns `powershell.exe` on Windows
// (flags -MaxChars / -FullRead / -Rate / -Volume / -CleanMarkdownFormatting /
// -ReadInlineCode) and `/bin/bash engine/speak.sh` on macOS (-m / -F / -r / -C / -I,
// where a flag is present only when it is needed: `-F` marks full read and `-r` is
// passed for a positive rate only; `say` follows the system volume, so volume is
// never passed). Asserting Windows argv on macOS is how a green-on-Windows test
// suite turns red on a Mac.
// ---------------------------------------------------------------------------
const IS_WIN = process.platform === 'win32'
const ENGINE_CMD = IS_WIN ? 'powershell.exe' : '/bin/bash'
const FLAG = {
  maxChars: IS_WIN ? '-MaxChars' : '-m',
  fullRead: IS_WIN ? '-FullRead' : '-F',
  rate: IS_WIN ? '-Rate' : '-r',
  cleanMarkdown: IS_WIN ? '-CleanMarkdownFormatting' : '-C',
  readInlineCode: IS_WIN ? '-ReadInlineCode' : '-I',
}
/** The engine process the queue spawned for the platform this test runs on. */
function engineSpawn() { return spawned.find(s => s.cmd === ENGINE_CMD) || spawned[0] }
/** argv value of one engine flag, or undefined when the flag is absent. */
function flagValue(args, name) { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }

async function main() {
  // ---- 1. default mode: optional events + throttled final reply ----
  const t1 = applyWith({ announceTurnEnd: true, announceCommandDone: true, announceGoalChange: true, announceToolErrors: true, announceTodoWrite: true, throttleMs: 10 })
  t1.fire('turn/end', { turn: 3, reason: { kind: 'completed' } })
  t1.fire('command/done', { kind: 'error' })
  t1.fire('goal/change', { operation: 'create', goal: { objective: '重构语音播报模块，让长任务完成时开口告诉你' } })
  t1.fire('tool/result', { error: { name: 'Error', code: 'EBLOCKED' } }) // 真实结构：只有 name/code
  t1.fire('todo/write', { todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }] })
  await t1.finishAll() // complete each queued item serially
  await t1.flush(20)
  console.log('--- default mode announced ---')
  announced.forEach((t, i) => console.log(`[${i}] ${t}`))
  assert.strictEqual(announced[0], '第 3 轮对话完成', 'turn/end completed')
  assert.strictEqual(announced[1], '命令执行失败', 'command/done error')
  assert.ok(announced[2].startsWith('已创建目标：重构语音播报模块'), `goal create: ${announced[2]}`)
  assert.strictEqual(announced[3], '工具调用出错', 'tool error (english code dropped)')
  assert.strictEqual(announced[4], '待办已更新：1/3 完成', 'todo write')

  // ---- 2. default mode: throttled final reply ----
  const t2 = applyWith({ throttleMs: 10 })
  t2.fireEvent('assistant/message', { turn: 5, step: 1, message: { id: 'm1', content: [{ type: 'text', text: '这是最终回复内容。' }] } })
  await t2.flush(30) // wait for throttle to fire + enqueue
  await t2.finishAll()
  await t2.flush(20)
  assert.ok(announced.includes('这是最终回复内容。'), `final reply announced: ${JSON.stringify(announced)}`)

  // ---- 3. master switch off: nothing announced ----
  const t3 = applyWith({ enabled: false, announceTurnEnd: true, throttleMs: 10 })
  t3.fire('turn/end', { turn: 7, reason: { kind: 'completed' } })
  t3.fireEvent('assistant/message', { turn: 8, step: 1, message: { id: 'm2', content: [{ type: 'text', text: '总开关关闭' }] } })
  await t3.flush(40)
  await t3.finishAll()
  await t3.flush(20)
  assert.strictEqual(announced.length, 0, `master switch off should announce nothing: ${JSON.stringify(announced)}`)

  // ---- 4. queueAllMessages mode: every assistant message enqueued ----
  const t4 = applyWith({ queueAllMessages: true, automaticSpeech: true, throttleMs: 10 })
  t4.fireEvent('assistant/message', { turn: 9, step: 1, message: { id: 'q1', content: [{ type: 'text', text: '中间消息一' }] } })
  t4.fireEvent('assistant/message', { turn: 9, step: 2, message: { id: 'q2', content: [{ type: 'text', text: '中间消息二' }] } })
  await t4.flush(30)
  await t4.finishAll()
  await t4.flush(20)
  assert.ok(announced.includes('中间消息一'), `queueAllMessages should speak intermediate: ${JSON.stringify(announced)}`)
  assert.ok(announced.includes('中间消息二'), `queueAllMessages should speak second message: ${JSON.stringify(announced)}`)

  // ---- 5. control route registered (via a fresh apply) ----
  const t5 = applyWith({})
  assert.ok(t5.__routes && t5.__routes['/dsh-speak/control'], 'control route registered')

  // ---- 6. turn/end fallback: tool-call round still announces the final reply ----
  const t6 = applyWith({ throttleMs: 10 })
  t6.fireEvent('assistant/message', { turn: 10, step: 1, message: { id: 'f1', content: [{ type: 'text', text: '这是带工具调用的最终回复。' }] } })
  t6.fire('tool/call', { name: 'pwsh', arguments: '{}' }) // cancels the throttle
  t6.fire('turn/end', { turn: 10, reason: { kind: 'completed' } }) // fallback speaks it
  await t6.flush(20)
  await t6.finishAll()
  await t6.flush(20)
  assert.ok(announced.includes('这是带工具调用的最终回复。'), `turn/end fallback should speak final reply: ${JSON.stringify(announced)}`)

  // ---- 7. no double speak: pure-text reply (already throttled) + turn/end ----
  const t7 = applyWith({ throttleMs: 10 })
  t7.fireEvent('assistant/message', { turn: 11, step: 1, message: { id: 'p1', content: [{ type: 'text', text: '纯文本最终回复' }] } })
  await t7.flush(30) // throttle fires first → lastSpokenText set
  t7.fire('turn/end', { turn: 11, reason: { kind: 'completed' } }) // must NOT repeat
  await t7.flush(20)
  await t7.finishAll()
  await t7.flush(20)
  const repeats = announced.filter(t => t === '纯文本最终回复').length
  assert.strictEqual(repeats, 1, `pure-text reply must speak exactly once: ${JSON.stringify(announced)}`)

  // ---- 8. ask_user_question: numbered options, turn/end must not repeat ----
  const t8 = applyWith({ announceQuestions: true, throttleMs: 10 })
  t8.fireEvent('assistant/message', { turn: 12, step: 1, message: { id: 'q3', content: [{ type: 'text', text: '你需要哪个方案？' }] } })
  t8.fire('tool/call', { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '选哪个？', options: [{ label: 'A' }, { label: 'B' }] }] }) })
  t8.fire('turn/end', { turn: 12, reason: { kind: 'completed' } })
  await t8.flush(20)
  await t8.finishAll()
  await t8.flush(20)
  assert.ok(announced.some(t => t === '选哪个？（单选），选项1，A；选项2，B'),
    `single question with numbered options: ${JSON.stringify(announced)}`)
  assert.ok(!announced.includes('你需要哪个方案？'), `question text must not repeat at turn/end: ${JSON.stringify(announced)}`)

  // ---- 9. engine booleans are passed as 1/0 on both platforms (PowerShell [bool]
  // rejects "true"; speak.sh compares against '1') ----
  const t9 = applyWith({ throttleMs: 10 })
  t9.fireEvent('assistant/message', { turn: 13, step: 1, message: { id: 'b1', content: [{ type: 'text', text: '布尔参数测试' }] } })
  await t9.flush(30)
  const ps = engineSpawn()
  assert.ok(ps, `${ENGINE_CMD} spawned`)
  const psArgs = ps.args
  for (const flag of [FLAG.cleanMarkdown, FLAG.readInlineCode]) {
    const idx = psArgs.indexOf(flag)
    assert.ok(idx >= 0 && (psArgs[idx + 1] === '1' || psArgs[idx + 1] === '0'),
      `${flag} must be 1/0, got ${JSON.stringify(psArgs.slice(idx, idx + 2))}`)
  }
  await t9.finishAll()
  await t9.flush(20)

  // ---- 10. tool/result isError block (pwsh-style failure, no error field) ----
  const t10 = applyWith({ announceToolErrors: true, throttleMs: 10 })
  t10.fire('tool/result', { message: { content: [{ type: 'text', text: 'Cannot find path because it does not exist', isError: true }] } })
  await t10.flush(20)
  await t10.finishAll()
  await t10.flush(20)
  assert.ok(announced.some(t => t === '工具调用出错'),
    `isError english text dropped: ${JSON.stringify(announced)}`)

  // ---- 10b. tool/result with Chinese error detail is kept ----
  const t10b = applyWith({ announceToolErrors: true, throttleMs: 10 })
  t10b.fire('tool/result', { message: { content: [{ type: 'text', text: '文件不存在，请检查路径', isError: true }] } })
  await t10b.flush(20)
  await t10b.finishAll()
  await t10b.flush(20)
  assert.ok(announced.some(t => t === '工具调用出错：文件不存在，请检查路径'),
    `chinese detail kept: ${JSON.stringify(announced)}`)

  // ---- 10c. 0.1.2+ shape: the result block is wrapped in a ToolResultBlock ----
  // createToolResultMessage nests the raw blocks under
  // { type:'tool-result', toolCallId, content:[…], isError } — the flagged block
  // carries no text of its own, so the detail must be read from its content.
  const t10c = applyWith({ announceToolErrors: true, throttleMs: 10 })
  t10c.fire('tool/result', { message: { content: [{
    type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: '文件不存在，请检查路径' }],
  }] } })
  await t10c.flush(20)
  await t10c.finishAll()
  await t10c.flush(20)
  assert.ok(announced.some(t => t === '工具调用出错：文件不存在，请检查路径'),
    `0.1.2+ wrapped isError detail read from nested content: ${JSON.stringify(announced)}`)

  // ---- 10d. a failing shell command is reported, not errored (host policy) ----
  // pwsh/bash settle a non-zero exit as result data (`exit code: N`) with no
  // isError, so announceToolErrors deliberately stays silent.
  const t10d = applyWith({ announceToolErrors: true, throttleMs: 10 })
  t10d.fire('tool/result', { message: { content: [{
    type: 'tool-result', toolCallId: 'c2', content: [{ type: 'text', text: 'Get-Content: 找不到路径\nexit code: 1' }],
  }] } })
  await t10d.flush(20)
  await t10d.finishAll()
  await t10d.flush(20)
  assert.ok(!announced.some(t => t.startsWith('工具调用出错')),
    `reported-not-errored shell failure stays silent: ${JSON.stringify(announced)}`)

  // ---- 10e. English error text is dropped even when the PATH contains Chinese ----
  // Regression (1.8.0): reading the nested content made the detail non-empty, and
  // the "is it Chinese?" gate only tested for the PRESENCE of a CJK character. A
  // path like ...\.第二轮测试用的不存在文件.txt satisfied it, so a pure English
  // error was read aloud: `工具调用出错：Error: cannot read "D:\...".
  const t10e = applyWith({ announceToolErrors: true, throttleMs: 10 })
  t10e.fire('tool/result', { message: { content: [{
    type: 'tool-result', toolCallId: 'c3', isError: true,
    content: [{ type: 'text', text: 'Error: cannot read "D:\\Projects\\dsh-speak\\.第二轮测试用的不存在文件.txt": not found' }],
  }] } })
  await t10e.flush(20)
  await t10e.finishAll()
  await t10e.flush(20)
  assert.ok(announced.includes('工具调用出错'),
    `english error with a Chinese path stays bare: ${JSON.stringify(announced)}`)
  assert.ok(!announced.some(t => t.startsWith('工具调用出错：')),
    `no detail may be spoken for an English error: ${JSON.stringify(announced)}`)

  // ---- 10f. a mostly-Chinese mixed detail is still kept ----
  const t10f = applyWith({ announceToolErrors: true, throttleMs: 10 })
  t10f.fire('tool/result', { message: { content: [{
    type: 'tool-result', toolCallId: 'c4', isError: true,
    content: [{ type: 'text', text: '读取配置文件失败 ENOENT' }],
  }] } })
  await t10f.flush(20)
  await t10f.finishAll()
  await t10f.flush(20)
  assert.ok(announced.some(t => t === '工具调用出错：读取配置文件失败 ENOENT'),
    `mostly-Chinese detail kept: ${JSON.stringify(announced)}`)

  // ---- 11. multi-question: each question separate, numbered, gap between ----
  const t11 = applyWith({ announceQuestions: true, questionGapMs: 2000, throttleMs: 10 })
  t11.fire('tool/call', { name: 'ask_user_question', arguments: JSON.stringify({ questions: [
    { question: '选部署方案？', options: [{ label: '方案A' }, { label: '方案B' }] },
    { question: '通知方式？', multi_select: true, options: [{ label: '邮件' }, { label: '短信' }, { label: '无' }] },
  ] }) })
  await t11.flush(20)
  await t11.finishAll() // 完成第一条 → 进入 2000ms 间隔
  await t11.flush(2100) // 等间隔到期 → 第二条才 spawn
  await t11.finishAll() // 完成第二条
  await t11.flush(20)
  assert.ok(announced.includes('问题1，选部署方案？（单选），选项1，方案A；选项2，方案B'),
    `q1 numbered: ${JSON.stringify(announced)}`)
  assert.ok(announced.includes('问题2，通知方式？（多选），选项1，邮件；选项2，短信；选项3，无'),
    `q2 numbered + multi: ${JSON.stringify(announced)}`)
  // 两条之间确实有 2 秒间隔：第二条不可能在第一条完成后立刻播
  assert.ok(announced.length >= 2, `both questions announced: ${JSON.stringify(announced)}`)

  // ---- 12. replay full read: control play passes -FullRead per replayFullRead ----
  async function controlPlay(routes, body) {
    const route = routes['/dsh-speak/control']
    const bodyBuf = Buffer.from(JSON.stringify(body))
    const req = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      [Symbol.asyncIterator]() { let sent = false; return { next: async () => sent ? { done: true } : (sent = true, { value: bodyBuf, done: false }) } },
    }
    let status = 0, payload = ''
    const res = { writeHead: (s) => { status = s }, end: (v) => { payload = String(v) } }
    await route(req, res)
    return { status, payload }
  }
  const t12 = applyWith({ replayFullRead: true, throttleMs: 10 })
  await controlPlay(t12.__routes, { action: 'play', text: '重播完整朗读测试' })
  await t12.flush(20)
  const ps12 = engineSpawn()
  assert.ok(ps12, `manual play spawned ${ENGINE_CMD}`)
  if (IS_WIN) {
    assert.strictEqual(flagValue(ps12.args, FLAG.fullRead), '1',
      `replayFullRead on → -FullRead 1: ${JSON.stringify(ps12.args)}`)
    // Windows 语速透传 cfg.rate（默认 0 = SAPI 正常），不再替换成 1
    assert.strictEqual(flagValue(ps12.args, FLAG.rate), '0',
      `default rate must pass 0 (SAPI normal), got ${JSON.stringify(ps12.args)}`)
  } else {
    // macOS 的 -F 是裸开关（engine/speak.sh 的 usage 写作 [-F]，`F) FULL_READ=1`），不带取值
    assert.ok(ps12.args.includes(FLAG.fullRead),
      `macOS passes a bare -F for full read: ${JSON.stringify(ps12.args)}`)
    // macOS: 0 = 引擎默认（语音自带 175 wpm），所以不传 -r
    assert.ok(!ps12.args.includes(FLAG.rate), `macOS must omit -r at the default rate: ${JSON.stringify(ps12.args)}`)
  }
  await t12.finishAll()
  await t12.flush(20)

  const t13 = applyWith({ replayFullRead: false, throttleMs: 10 })
  await controlPlay(t13.__routes, { action: 'play', text: '重播走heading' })
  await t13.flush(20)
  const ps13 = engineSpawn()
  assert.ok(ps13, `manual play spawned ${ENGINE_CMD} (off)`)
  if (IS_WIN) {
    assert.strictEqual(flagValue(ps13.args, FLAG.fullRead), '0',
      `replayFullRead off → -FullRead 0: ${JSON.stringify(ps13.args)}`)
  } else {
    assert.ok(!ps13.args.includes(FLAG.fullRead), `macOS omits -F when replayFullRead is off: ${JSON.stringify(ps13.args)}`)
  }
  await t13.finishAll()
  await t13.flush(20)

  // ---- 14. approval/asked: generic action-label prefix stripped, Chinese kept ----
  async function approvalCase(announce, reason) {
    const t = applyWith({ announceApprovals: announce, throttleMs: 10 })
    t.fire('approval/asked', { reason })
    await t.flush(20)
    await t.finishAll()
    await t.flush(20)
    return announced
  }
  // 英文动作短语 + 冒号前缀 → 只念冒号后的内容（memory 工具的真实样例）
  let out = await approvalCase(true, 'Store decision fact in workspace memory (dsh-speak): dsh-speak 暂不适配 DSH 0.1.2/0.1.3')
  assert.ok(out.some(t => t === 'dsh-speak 暂不适配 DSH 0.1.2/0.1.3'),
    `english action prefix stripped: ${JSON.stringify(out)}`)
  // 旧固定前缀（escalate sandbox）回归
  out = await approvalCase(true, 'escalate sandbox to danger-full-access: 需要写入 ~/.dsh 目录')
  assert.ok(out.some(t => t === '需要写入 ~/.dsh 目录'),
    `escalate sandbox prefix stripped: ${JSON.stringify(out)}`)
  // 中文开头 / 无冒号 → 原样保留
  out = await approvalCase(true, '删除 mneme 插件残留的记忆数据目录（工作区外）')
  assert.ok(out.some(t => t === '删除 mneme 插件残留的记忆数据目录（工作区外）'),
    `chinese reason kept verbatim: ${JSON.stringify(out)}`)
  out = await approvalCase(true, '请确认是否允许网络访问')
  assert.ok(out.some(t => t === '请确认是否允许网络访问'),
    `no-colon reason kept: ${JSON.stringify(out)}`)
  // announceApprovals off → 不播
  out = await approvalCase(false, 'escalate sandbox to danger-full-access: 不应播报')
  assert.ok(!out.some(t => t === '不应播报'), `announceApprovals off silent: ${JSON.stringify(out)}`)

  // ---- 15. numeric normalization: an explicit 0 survives; SAPI-unsafe values clamp ----
  // A user's 0 is meaningful (volume 0 = silence, maxChars 0 = unlimited) and used to
  // be swallowed by `|| fallback`; an out-of-range SAPI Rate/Volume makes speak.ps1
  // throw, so it must be clamped before it reaches the engine.
  const t15 = applyWith({ throttleMs: 10, volume: 0, maxChars: 0, rate: IS_WIN ? 175 : 0 })
  t15.fireEvent('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '数值规整检查。' }] } })
  await t15.flush(120)
  const spawnedEngine = engineSpawn()
  assert.ok(spawnedEngine && Array.isArray(spawnedEngine.args),
    `a speech process was spawned: ${JSON.stringify(spawned.map(s => s.cmd))}`)
  const engineArgs = spawnedEngine.args
  assert.strictEqual(flagValue(engineArgs, FLAG.maxChars), '0',
    `explicit maxChars 0 must reach the engine, got ${flagValue(engineArgs, FLAG.maxChars)}`)
  if (IS_WIN) {
    assert.strictEqual(flagValue(engineArgs, '-Volume'), '0', `explicit volume 0 must reach the engine, got ${flagValue(engineArgs, '-Volume')}`)
    assert.strictEqual(flagValue(engineArgs, '-Rate'), '10', `out-of-range SAPI rate must clamp to 10, got ${flagValue(engineArgs, '-Rate')}`)
  } else {
    // macOS has no volume flag (`say` follows the system volume) and rate 0 means
    // "engine default", so neither is passed.
    assert.ok(!engineArgs.includes('-Volume'), 'macOS must not pass a volume flag')
    assert.ok(!engineArgs.includes('-r'), 'macOS rate 0 = engine default: no -r flag')
  }
  await t15.finishAll()

  console.log('ALL PASS ✓')
  process.exit(0)
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1) })
