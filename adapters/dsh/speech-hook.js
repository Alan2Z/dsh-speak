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
//   * when a tool/call event arrives, that round's assistant text is treated as
//     process narration, so any pending announcement is cancelled — EXCEPT a
//     call to `ask_user_question`, which is a question for the user and keeps
//     the pending text so it is announced
//   * `approval/asked` is announced immediately (approval reason, or a fixed
//     prompt) since approvals are time-sensitive
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
// Configuration (environment variables, optional):
//   DSH_SPEAK_ENGINE      path to the engine script (speak.ps1 / speak.sh)
//                         (default: <package>/engine/<platform script>, then
//                          ~/.dsh/hooks/<platform script>)
//   DSH_SPEAK_THROTTLE_MS throttle delay before announcing (default: 1500)
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

const THROTTLE_MS = Number(process.env.DSH_SPEAK_THROTTLE_MS) || 1500
const ENGINE_NAME = process.platform === 'darwin' ? 'speak.sh' : 'speak.ps1'

/**
 * Locate the engine script:
 *   1. explicit DSH_SPEAK_ENGINE override
 *   2. <this package>/engine/<speak.ps1|speak.sh> — works both when running from
 *      a repo checkout and when installed into a profile's node_modules
 *   3. legacy file-copy location (~/.dsh/hooks/<speak.ps1|speak.sh>)
 */
function resolveEngine() {
  if (process.env.DSH_SPEAK_ENGINE) return process.env.DSH_SPEAK_ENGINE
  const bundled = path.join(__dirname, '..', '..', 'engine', ENGINE_NAME)
  if (fs.existsSync(bundled)) return bundled
  return path.join(os.homedir(), '.dsh', 'hooks', ENGINE_NAME)
}
const SPEAK_ENGINE = resolveEngine()

module.exports = {
  apply(ctx) {
    log('plugin apply 执行（加载成功）; engine=', SPEAK_ENGINE, '; throttle=', THROTTLE_MS)
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
        ps = spawn('/bin/bash', [SPEAK_ENGINE, '-f', tmp], { stdio: 'ignore' })
        log('spawn bash (macOS engine) 已发起')
      } else {
        ps = spawn('powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SPEAK_ENGINE, '-File', tmp],
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
        // tool-call round: a call to ask_user_question is a question to the
        // user — keep the pending text so it gets announced (the user should
        // hear the question); any other tool call cancels the pending
        // announcement (that round's assistant text is process narration)
        if (type === 'tool/call') {
          const toolName = event.data && event.data.name
          if (toolName === 'ask_user_question') {
            log('提问工具调用（ask_user_question）— 保留待播报文本')
            return
          }
          cancelPending()
          return
        }
        // approval requested: announce it right away (time-sensitive), using
        // the approval reason if present
        if (type === 'approval/asked') {
          cancelPending()
          const reason = event.data && event.data.reason
          const text = reason && reason.trim() ? reason : '需要你的审批，请查看界面。'
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
        }, THROTTLE_MS)
      } catch (e) {
        log('事件处理异常:', e.message)
      }
    })
  },
}
