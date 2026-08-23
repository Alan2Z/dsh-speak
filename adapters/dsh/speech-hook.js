// speech-hook.js — DSH web adapter: auto voice-announce the final assistant reply
// ==============================================================================
// Listens to the session event stream (session/event), watches for
// assistant/message append events, extracts the final reply text, and hands it to
// the speech engine (engine/speak.ps1 on Windows, engine/speak.sh on macOS)
// through a hidden, non-blocking child process.
//
// Trigger semantics:
//   * only events with a `text` block are announced (reasoning / tool_use blocks
//     are skipped)
//   * a tool/call to `ask_user_question` announces the parsed question
//     (title + single/multi + options); other tool calls cancel the pending
//     announcement (that round's assistant text is process narration)
//   * `approval/asked` is announced immediately (reason with the fixed English
//     template prefix stripped, or a fixed prompt)
//   * a final reply with no following tool/call is announced after a throttle
//     delay (merges multi-step messages from the same reply)
//   * optional event announcements (all off by default): turn/end,
//     command/done, goal/change, tool/result errors, todo/write
//
// Configuration — prefer the profile patch `config` block (see docs/CUSTOMIZATION.md):
//   - insert:
//       - id: speech-hook
//         name: 'dsh-speak'
//         config:
//           throttleMs: 1500        # merge delay before announcing (ms)
//           engine: ''              # engine path override; '' = auto-resolve
//           announceApprovals: true # speak approval requests
//           announceQuestions: true # speak ask_user_question content
//           stripApprovalPrefix: true  # strip "escalate sandbox to ...: " prefix
//           longTextMode: message   # message | heading (speak largest md heading)
//           maxChars: 300           # engine per-utterance ceiling
//           volume: 50              # Windows only
//           rate: 0                 # 0 = engine default (Windows SAPI scale / macOS wpm)
//           # optional event announcements (off by default):
//           announceTurnEnd: false     # turn/end — "第 N 轮对话完成"
//           announceCommandDone: false # command/done — "命令执行完成/失败"
//           announceGoalChange: false  # goal/change — "目标已创建/更新/完成…"
//           announceToolErrors: false  # tool/result with error — "工具调用出错：…"
//           announceTodoWrite: false   # todo/write — "待办已更新：n/m 完成"
//
// Since 1.6.0 the plugin also registers a `dsh-speak` settings namespace so the
// same options are visible and editable in 设置 → 插件 → 插件配置 (the browser
// half ships in client/client.js). The registration is best-effort: hosts with
// no settings service (dsh before 0.1.0-rc.7) simply keep the patch config.
'use strict'
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

// diagnostic log (for troubleshooting; safe to remove once stable)
const LOG = path.join(os.tmpdir(), 'dsh-speech-hook.log')
function log(...args) {
  try {
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(' ')}\n`)
  } catch (e) { /* ignore */ }
}

const ENGINE_NAME = process.platform === 'darwin' ? 'speak.sh' : 'speak.ps1'
// Settings namespace of this plugin (lowercase kebab-case; must match the
// browser card's key in client/client.js).
const SETTINGS_NS = 'dsh-speak'

/**
 * Locate the engine script:
 *   1. explicit override (config `engine`)
 *   2. <this package>/engine/<speak.ps1|speak.sh> — works both when running from
 *      a repo checkout and when installed into a profile's node_modules
 *   3. legacy file-copy location (~/.dsh/hooks/<speak.ps1|speak.sh>)
 */
function resolveEngine(override) {
  if (override) return override
  const bundled = path.join(__dirname, '..', '..', 'engine', ENGINE_NAME)
  if (fs.existsSync(bundled)) return bundled
  return path.join(os.homedir(), '.dsh', 'hooks', ENGINE_NAME)
}

// ---------------------------------------------------------------------------
// Settings namespace (best-effort; see installSettingsSection in dsh-settings)
// ---------------------------------------------------------------------------
// The schema mirrors the patch-config keys above. Values resolve as:
// schema default → patch `config` (base) → user settings layer (the UI).
const SCHEMA_DEFAULTS = {
  enabled: true,
  throttleMs: 1500,
  engine: '',
  announceApprovals: true,
  announceQuestions: true,
  stripApprovalPrefix: true,
  longTextMode: 'message',
  longTextMessage: '本次播报内容较长，请自行阅读。',
  maxChars: 300,
  volume: 50,
  rate: 0,
  announceTurnEnd: false,
  announceCommandDone: false,
  announceGoalChange: false,
  announceToolErrors: false,
  announceTodoWrite: false,
}

/**
 * Register the `dsh-speak` settings namespace, then keep `cfg` in sync with the
 * resolved value (defaults → patch base → user layer). Best-effort: any failure
 * (no settings service, missing peer package) leaves `cfg` on the patch config.
 *
 * @param ctx - the plugin context.
 * @param cfg - the mutable config object the event handler reads.
 * @param patch - the patch `config` object (base layer).
 */
function installSettingsNamespace(ctx, cfg, patch) {
  // schemastery has a CJS build; dsh-settings is ESM-only, so load it dynamically.
  let z
  let settingsModuleUrl
  try {
    z = require('@deepseek-ai/schemastery')
    // resolve the ESM package's real file path through CJS resolution (honors
    // upward node_modules walk and NODE_PATH), then import() that path — a bare
    // specifier import() would only resolve from this file's own location.
    const { createRequire } = require('module')
    const resolved = createRequire(__filename).resolve('@deepseek-ai/dsh-settings')
    settingsModuleUrl = require('url').pathToFileURL(resolved).href
  } catch (e) {
    log('settings 依赖不可用，跳过 settings namespace 注册:', e && e.message)
    return
  }
  const schema = z.object({
    enabled: z.boolean().default(SCHEMA_DEFAULTS.enabled),
    throttleMs: z.number().default(SCHEMA_DEFAULTS.throttleMs),
    engine: z.string().default(SCHEMA_DEFAULTS.engine),
    announceApprovals: z.boolean().default(SCHEMA_DEFAULTS.announceApprovals),
    announceQuestions: z.boolean().default(SCHEMA_DEFAULTS.announceQuestions),
    stripApprovalPrefix: z.boolean().default(SCHEMA_DEFAULTS.stripApprovalPrefix),
    longTextMode: z.union([z.const('message'), z.const('heading')]).default(SCHEMA_DEFAULTS.longTextMode),
    longTextMessage: z.string().default(SCHEMA_DEFAULTS.longTextMessage),
    maxChars: z.number().default(SCHEMA_DEFAULTS.maxChars),
    volume: z.number().default(SCHEMA_DEFAULTS.volume),
    rate: z.number().default(SCHEMA_DEFAULTS.rate),
    announceTurnEnd: z.boolean().default(SCHEMA_DEFAULTS.announceTurnEnd),
    announceCommandDone: z.boolean().default(SCHEMA_DEFAULTS.announceCommandDone),
    announceGoalChange: z.boolean().default(SCHEMA_DEFAULTS.announceGoalChange),
    announceToolErrors: z.boolean().default(SCHEMA_DEFAULTS.announceToolErrors),
    announceTodoWrite: z.boolean().default(SCHEMA_DEFAULTS.announceTodoWrite),
  })
  import(settingsModuleUrl).then(({ installSettingsSection }) => {
    const entry = { ...SCHEMA_DEFAULTS, ...(patch || {}) }
    let source = () => entry
    installSettingsSection(ctx, SETTINGS_NS, schema, entry, {
      setSource: (current) => { source = current },
      onChange: () => {
        try {
          const next = source()
          // engine 是路径覆盖：空串要重新自动解析，不能直接覆盖已解析的绝对路径
          Object.assign(cfg, next, { engine: resolveEngine(next.engine || '') })
          log('settings 变更已应用; cfg=', JSON.stringify(cfg))
        } catch (e) {
          log('settings 变更应用失败:', e && e.message)
        }
      },
    })
  }).catch((e) => {
    log('dsh-settings 不可用，跳过 settings namespace 注册:', e && e.message)
  })
}

module.exports = {
  apply(ctx, config) {
    config = config || {}
    // resolved settings: config > default
    const cfg = {
      enabled: config.enabled !== false,
      throttleMs: Number(config.throttleMs != null ? config.throttleMs : SCHEMA_DEFAULTS.throttleMs) || SCHEMA_DEFAULTS.throttleMs,
      engine: resolveEngine(config.engine || ''),
      announceApprovals: config.announceApprovals !== false,
      announceQuestions: config.announceQuestions !== false,
      stripApprovalPrefix: config.stripApprovalPrefix !== false,
      longTextMode: config.longTextMode || SCHEMA_DEFAULTS.longTextMode,
      longTextMessage: config.longTextMessage || SCHEMA_DEFAULTS.longTextMessage,
      maxChars: Number(config.maxChars != null ? config.maxChars : SCHEMA_DEFAULTS.maxChars) || SCHEMA_DEFAULTS.maxChars,
      volume: Number(config.volume != null ? config.volume : SCHEMA_DEFAULTS.volume) || SCHEMA_DEFAULTS.volume,
      rate: Number(config.rate != null ? config.rate : SCHEMA_DEFAULTS.rate) || SCHEMA_DEFAULTS.rate,
      // optional event announcements (off by default)
      announceTurnEnd: config.announceTurnEnd === true,
      announceCommandDone: config.announceCommandDone === true,
      announceGoalChange: config.announceGoalChange === true,
      announceToolErrors: config.announceToolErrors === true,
      announceTodoWrite: config.announceTodoWrite === true,
    }
    log('plugin apply 执行（加载成功）; enabled=', cfg.enabled, '; engine=', cfg.engine, '; throttle=', cfg.throttleMs,
      '; longTextMode=', cfg.longTextMode, '; maxChars=', cfg.maxChars,
      '; announceTurnEnd=', cfg.announceTurnEnd, '; announceCommandDone=', cfg.announceCommandDone,
      '; announceGoalChange=', cfg.announceGoalChange, '; announceToolErrors=', cfg.announceToolErrors,
      '; announceTodoWrite=', cfg.announceTodoWrite)
    // Best-effort settings integration; cfg is mutated in place on changes.
    installSettingsNamespace(ctx, cfg, config)

    let timer = null
    let pendingText = ''

    /** cancel a pending announcement (called when a tool-call round arrives) */
    function cancelPending() {
      if (timer) { clearTimeout(timer); timer = null }
      pendingText = ''
    }

    function speak(text) {
      // 总开关：关闭后不触发任何播报（最终回复 / 审批 / 提问 / 可选事件）
      if (!cfg.enabled) {
        log('总开关关闭，跳过播报（文本长度:', text ? text.length : 0, '）')
        return
      }
      log('speak 调用, 文本长度:', text ? text.length : 0)
      if (!text || !text.trim()) return
      const tmp = path.join(os.tmpdir(), `dsh-speech-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
      try {
        fs.writeFileSync(tmp, text, 'utf8')
      } catch (e) {
        log('写临时文件失败:', e.message)
        return
      }
      let ps
      if (process.platform === 'darwin') {
        // macOS: run the say-based engine through bash
        const args = ['-f', tmp, '-m', String(cfg.maxChars), '-M', cfg.longTextMode, '-l', cfg.longTextMessage]
        if (cfg.rate > 0) args.push('-r', String(cfg.rate))
        ps = spawn('/bin/bash', [cfg.engine].concat(args), { stdio: 'ignore' })
        log('spawn bash (macOS engine) 已发起:', args.join(' '))
      } else {
        ps = spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.engine,
            '-File', tmp,
            '-Volume', String(cfg.volume),
            '-Rate', String(cfg.rate > 0 ? cfg.rate : 1),
            '-MaxChars', String(cfg.maxChars),
            '-LongTextMode', cfg.longTextMode,
            '-LongTextMessage', cfg.longTextMessage],
          { windowsHide: true, stdio: 'ignore' })
        log('spawn powershell 已发起')
      }
      ps.on('exit', (code) => { log('播报进程退出 code=', code); try { fs.unlinkSync(tmp) } catch (e) { /* 清理 */ } })
      ps.on('error', (e) => { log('播报进程 error:', e.message); try { fs.unlinkSync(tmp) } catch (e2) { /* 清理 */ } })
    }

    // ---------- optional event announcements ----------
    /** turn/end: "第 N 轮对话完成" (reason-aware, kept short) */
    function announceTurnEnd(data) {
      const turn = data && data.turn
      const kind = data && data.reason && data.reason.kind
      const prefix = turn != null ? `第 ${turn} 轮对话` : '本轮对话'
      switch (kind) {
        case 'completed': return prefix + '完成'
        case 'aborted': case 'interrupted': return prefix + '中断'
        case 'blocked': return prefix + '被阻塞'
        case 'error': case 'max-tokens': return prefix + '异常结束'
        default: return prefix + '结束'
      }
    }
    /** command/done: "命令执行完成/失败" */
    function announceCommandDone(data) {
      const kind = data && data.kind
      return kind === 'error' ? '命令执行失败' : '命令执行完成'
    }
    /** goal/change: operation + objective (truncated) */
    function announceGoalChange(data) {
      const op = data && data.operation
      const objective = data && data.goal && data.goal.objective
      const label = { create: '已创建目标', edit: '目标已更新', complete: '目标已完成', pause: '目标已暂停', resume: '目标已恢复', block: '目标已阻塞', clear: '目标已清除' }[op] || '目标状态变化'
      if (objective && (op === 'create' || op === 'edit' || op === 'complete')) {
        const head = objective.replace(/\s+/g, ' ').trim().slice(0, 40)
        return `${label}：${head}`
      }
      return label
    }
    /** tool/result: only when the tool reported an error */
    function announceToolError(data) {
      const err = data && data.error
      if (!err) return ''
      const detail = (err.message || err.code || '工具调用出错').replace(/\s+/g, ' ').trim().slice(0, 60)
      return `工具调用出错：${detail}`
    }
    /** todo/write: "待办已更新：n/m 完成" */
    function announceTodoWrite(data) {
      const todos = Array.isArray(data && data.todos) ? data.todos : []
      const done = todos.filter((t) => t && t.status === 'completed').length
      return `待办已更新：${done}/${todos.length} 完成`
    }

    ctx.on('session/event', (session, event) => {
      try {
        const type = event && event.type
        // noise filter: assistant/chunk (streaming chunks) is not recorded
        if (type !== 'assistant/chunk') {
          log('事件 type=', type, 'surfaceOp=', event && event.surfaceOp, 'seq=', event && event.seq)
        }
        // tool-call round: a call to ask_user_question announces the parsed
        // question (title + mode + options); any other tool call cancels the
        // pending announcement (that round's assistant text is narration)
        if (type === 'tool/call') {
          const toolName = event.data && event.data.name
          if (toolName === 'ask_user_question' && cfg.announceQuestions) {
            let spoken = ''
            try {
              const args = JSON.parse((event.data && event.data.arguments) || '{}')
              const qs = Array.isArray(args.questions) ? args.questions : []
              spoken = qs.map((q) => {
                const mode = q.multi_select ? '多选' : '单选'
                const labels = Array.isArray(q.options)
                  ? q.options.map((o) => o.label).filter(Boolean).join('、')
                  : ''
                return (q.question || '') + '（' + mode + '）' + (labels ? '，选项：' + labels : '')
              }).filter(Boolean).join('；')
            } catch (e) { /* arguments 解析失败则回退原逻辑 */ }
            if (spoken) {
              cancelPending()
              log('提问播报:', spoken.slice(0, 120))
              speak(spoken)
            } else {
              log('提问工具调用（ask_user_question）— 保留待播报文本')
            }
            return
          }
          cancelPending()
          return
        }
        // approval requested: announce it right away (time-sensitive), using
        // the approval reason if present
        if (type === 'approval/asked' && cfg.announceApprovals) {
          cancelPending()
          let reason = (event.data && event.data.reason) || ''
          if (cfg.stripApprovalPrefix) {
            // strip the fixed English template prefix (e.g. "escalate sandbox
            // to danger-full-access: "), keep the human explanation
            reason = reason.replace(/^escalate sandbox to danger-full-access\s*:\s*/i, '').trim()
          }
          const text = reason || '需要你的审批，请查看界面。'
          log('审批请求，播报:', text.slice(0, 60))
          speak(text)
          return
        }
        // optional event announcements (off by default)
        if (type === 'turn/end' && cfg.announceTurnEnd) {
          const text = announceTurnEnd(event.data)
          log('回合结束播报:', text)
          speak(text)
          return
        }
        if (type === 'command/done' && cfg.announceCommandDone) {
          const text = announceCommandDone(event.data)
          log('命令完成播报:', text)
          speak(text)
          return
        }
        if (type === 'goal/change' && cfg.announceGoalChange) {
          const text = announceGoalChange(event.data)
          log('目标变更播报:', text)
          speak(text)
          return
        }
        if (type === 'tool/result' && cfg.announceToolErrors) {
          const text = announceToolError(event.data)
          if (text) {
            log('工具出错播报:', text)
            speak(text)
          }
          return
        }
        if (type === 'todo/write' && cfg.announceTodoWrite) {
          const text = announceTodoWrite(event.data)
          log('待办更新播报:', text)
          speak(text)
          return
        }
        if (!event || type !== 'assistant/message') return
        if (event.surfaceOp && event.surfaceOp !== 'append') return
        // the message object lives at event.data.message (event.data wraps { turn, step, message })
        const msg = event.data && (event.data.message || event.data)
        if (!msg) return
        let text = ''
        const c = msg.content
        if (typeof c === 'string') {
          text = c
        } else if (Array.isArray(c)) {
          // only text blocks: reasoning / tool_use blocks are not announced
          text = c
            .filter(b => b && b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text)
            .join('')
        }
        if (!text.trim()) return
        log('缓存待播报文本长度:', text.length, '前 60:', text.slice(0, 60))
        pendingText = text
        if (timer) clearTimeout(timer)
        // throttle: merge multi-step messages of one reply; a tool/call in
        // between cancels the announcement
        timer = setTimeout(() => {
          speak(pendingText)
          pendingText = ''
          timer = null
        }, cfg.throttleMs)
      } catch (e) {
        log('事件处理异常:', e.message)
      }
    })
  },
}
