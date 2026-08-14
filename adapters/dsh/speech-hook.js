// speech-hook.js — DSH web adapter: auto voice-announce the final assistant reply
// ==============================================================================
// Listens to the session event stream (session/event), watches for
// assistant/message append events, extracts the final reply text, and hands it to
// engine/speak.ps1 through a hidden, non-blocking powershell process.
//
// Trigger semantics:
//   * only events with a `text` block are announced (reasoning / tool_use blocks
//     are skipped)
//   * when a tool/call event arrives, that round's assistant text is treated as
//     process narration, so any pending announcement is cancelled
//   * a final reply with no following tool/call is announced after a throttle
//     delay (merges multi-step messages from the same reply)
//
// Registration: add an insert entry in ~/.dsh/profiles/web/cordis.patch.yml —
//   - insert:
//       - id: speech-hook
//         name: 'file:///C:/Users/<you>/.dsh/profiles/web/plugins/speech-hook.js'
// (run adapters/dsh/install.ps1 to do this automatically)
//
// Configuration (environment variables, optional):
//   DSH_SPEAK_ENGINE      path to engine/speak.ps1
//                         (default: %USERPROFILE%\.dsh\hooks\speak.ps1)
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
const SPEAK_ENGINE =
  process.env.DSH_SPEAK_ENGINE ||
  path.join(process.env.USERPROFILE, '.dsh', 'hooks', 'speak.ps1')

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
      const ps = spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SPEAK_ENGINE, '-File', tmp],
        { windowsHide: true, stdio: 'ignore' })
      log('spawn powershell 已发起')
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
        // tool-call round: cancel pending announcement (that round's assistant
        // text is process narration, not the final reply)
        if (type === 'tool/call') {
          cancelPending()
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
