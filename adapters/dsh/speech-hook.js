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
//
// Registration: add an insert entry in ~/.dsh/profiles/web/cordis.patch.yml —
//   - insert:
//       - id: speech-hook
//         name: 'dsh-speak'                       # npm package (preferred)
//         name: 'file:///C:/Users/<your-username>/.../speech-hook.js'   # repo/file install (replace <your-username>)
// (run adapters/dsh/install.ps1 to do this automatically for the file install)
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

module.exports = {
  apply(ctx, config) {
    config = config || {}
    // resolved settings: config > default
    const cfg = {
      throttleMs: Number(config.throttleMs != null ? config.throttleMs : 1500) || 1500,
      engine: resolveEngine(config.engine || ''),
      announceApprovals: config.announceApprovals !== false,
      announceQuestions: config.announceQuestions !== false,
      stripApprovalPrefix: config.stripApprovalPrefix !== false,
      longTextMode: config.longTextMode || 'message',
      maxChars: Number(config.maxChars != null ? config.maxChars : 300) || 300,
      volume: Number(config.volume != null ? config.volume : 50) || 50,
      rate: Number(config.rate != null ? config.rate : 0) || 0,
    }
    log('plugin apply 执行（加载成功）; engine=', cfg.engine, '; throttle=', cfg.throttleMs,
      '; longTextMode=', cfg.longTextMode, '; maxChars=', cfg.maxChars)

    let timer = null
    let pendingText = ''

    /** cancel a pending announcement (called when a tool-call round arrives) */
    function cancelPending() {
      if (timer) { clearTimeout(timer); timer = null }
      pendingText = ''
    }

    function speak(text) {
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
        const args = ['-f', tmp, '-m', String(cfg.maxChars), '-M', cfg.longTextMode]
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
            '-LongTextMode', cfg.longTextMode],
          { windowsHide: true, stdio: 'ignore' })
        log('spawn powershell 已发起')
      }
      ps.on('exit', (code) => { log('播报进程退出 code=', code); try { fs.unlinkSync(tmp) } catch (e) { /* 清理 */ } })
      ps.on('error', (e) => { log('播报进程 error:', e.message); try { fs.unlinkSync(tmp) } catch (e2) { /* 清理 */ } })
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
