'use strict'

const { spawn } = require('child_process')
const { createRequire } = require('module')
const { WebSocketServer, WebSocket } = require('ws')
const fs = require('fs')
const os = require('os')
const path = require('path')

const LOG = path.join(os.tmpdir(), 'dsh-speech-hook.log')
function log(...args) {
  try { fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${args.join(' ')}\n`) } catch (e) { /* ignore */ }
}

const ENGINE_NAME = process.platform === 'darwin' ? 'speak.sh' : 'speak.ps1'
function resolveEngine(override) {
  if (override) return override
  const bundled = path.join(__dirname, '..', '..', 'engine', ENGINE_NAME)
  if (fs.existsSync(bundled)) return bundled
  return path.join(os.homedir(), '.dsh', 'hooks', ENGINE_NAME)
}

module.exports = {
  apply(ctx, config) {
    config = config || {}
    function resolveConfig(value) {
      value = value || {}
      return {
        automaticSpeech: value.automaticSpeech !== false,
        automaticSpeechMode: value.automaticSpeechMode === 'foreground' ? 'foreground' : 'background',
        cleanMarkdownFormatting: value.cleanMarkdownFormatting !== false,
        readInlineCode: value.readInlineCode !== false,
        codeBlocks: ['all', 'smart', 'replace'].includes(value.codeBlocks) ? value.codeBlocks : 'smart',
        codeBlockMaxChars: Number(value.codeBlockMaxChars != null ? value.codeBlockMaxChars : 300),
        codeBlockReplacementText: String(value.codeBlockReplacementText || 'You can see the code in our history.'),
        throttleMs: Number(value.throttleMs != null ? value.throttleMs : 1500) || 1500,
        engine: resolveEngine(value.engine || ''),
        announceApprovals: value.announceApprovals !== false,
        announceQuestions: value.announceQuestions !== false,
        stripApprovalPrefix: value.stripApprovalPrefix !== false,
        longTextMode: value.longTextMode === 'heading' ? 'heading' : 'message',
        maxChars: Number(value.maxChars != null ? value.maxChars : (process.platform === 'darwin' ? 0 : 300)),
        volume: Number(value.volume != null ? value.volume : 50) || 50,
        rate: Number(value.rate != null ? value.rate : 0) || 0,
      }
    }

    let cfg = resolveConfig(config)
    ctx.inject(['timer'], timerCtx => {
      timerCtx.timer.timeout(() => {
        try {
          const profileRequire = createRequire(ctx.baseUrl || __filename)
          const z = profileRequire('@deepseek-ai/schemastery')
          const { installSettingsSection, settingsNamespace } = profileRequire('@deepseek-ai/dsh-settings')
          const schema = z.object({
            automaticSpeech: z.boolean().default(true), automaticSpeechMode: z.union(['background', 'foreground']).default('background'), cleanMarkdownFormatting: z.boolean().default(true),
            readInlineCode: z.boolean().default(true), codeBlocks: z.union(['all', 'smart', 'replace']).default('smart'),
            codeBlockMaxChars: z.natural().default(300), codeBlockReplacementText: z.string().default('You can see the code in our history.'),
            maxChars: z.natural().default(process.platform === 'darwin' ? 0 : 300), longTextMode: z.union(['message', 'heading']).default('message'),
            announceApprovals: z.boolean().default(true), announceQuestions: z.boolean().default(true),
            throttleMs: z.natural().default(1500), engine: z.string().default(''), stripApprovalPrefix: z.boolean().default(true),
            volume: z.natural().default(50), rate: z.number().default(0),
          })
          installSettingsSection(ctx, settingsNamespace('dsh-speak'), schema, config, {
            setSource: source => { cfg = resolveConfig(source()) },
            onChange: () => { log('dsh-speak settings updated') },
          })
        } catch (e) { log('settings registration failed:', e.message) }
      }, 0)
    })

    let activeSpeech = null
    let speechToken = 0
    let replacement = null
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
      if (!item || !item.text.trim() || activeSpeech) return false
      const tmp = path.join(os.tmpdir(), `dsh-speech-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
      try { fs.writeFileSync(tmp, item.text, 'utf8') } catch (e) { log('write temp failed:', e.message); return false }
      log('speech start', item.source, item.sessionId || '-', item.turn == null ? '-' : item.turn, item.messageId || '-', item.text.slice(0, 80))
      let child
      if (process.platform === 'darwin') {
        const args = ['-f', tmp, '-m', String(cfg.maxChars), '-M', cfg.longTextMode, '-C', cfg.cleanMarkdownFormatting ? '1' : '0', '-I', cfg.readInlineCode ? '1' : '0', '-B', cfg.codeBlocks, '-K', String(cfg.codeBlockMaxChars), '-R', cfg.codeBlockReplacementText]
        if (cfg.rate > 0) args.push('-r', String(cfg.rate))
        child = spawn('/bin/bash', [cfg.engine].concat(args), { detached: true, stdio: 'ignore' })
      } else {
        child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cfg.engine, '-File', tmp, '-Volume', String(cfg.volume), '-Rate', String(cfg.rate > 0 ? cfg.rate : 1), '-MaxChars', String(cfg.maxChars), '-LongTextMode', cfg.longTextMode, '-CleanMarkdownFormatting', String(cfg.cleanMarkdownFormatting), '-ReadInlineCode', String(cfg.readInlineCode), '-CodeBlocks', cfg.codeBlocks, '-CodeBlockMaxChars', String(cfg.codeBlockMaxChars), '-CodeBlockReplacementText', cfg.codeBlockReplacementText], { windowsHide: true, stdio: 'ignore' })
      }
      const token = ++speechToken
      activeSpeech = { process: child, tmp, token, item }
      publishState()
      const settle = () => {
        removeTemp(tmp)
        if (!activeSpeech || activeSpeech.token !== token) return
        activeSpeech = null
        publishState()
        if (replacement) {
          const next = replacement
          replacement = null
          startOne(next)
        } else {
          startNext()
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
      speechQueue.length = 0
      publishState()
      return stopActive()
    }
    function replaceWith(item) {
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
            replaceWith({ source: 'manual', sessionId: body.sessionId == null ? null : String(body.sessionId), turn: Number.isFinite(body.turn) ? body.turn : null, messageId: body.messageId == null ? null : String(body.messageId), text: body.text })
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

    ctx.on('session/event', (session, event) => {
      try {
        const type = event && event.type
        if (type === 'tool/call') {
          if (event.data && event.data.name === 'ask_user_question' && cfg.announceQuestions) {
            let text = ''
            try {
              const args = JSON.parse(event.data.arguments || '{}')
              text = (Array.isArray(args.questions) ? args.questions : []).map(question => {
                const options = Array.isArray(question.options) ? question.options.map(option => option.label).filter(Boolean).join(', ') : ''
                return `${question.question || ''}${options ? `. Options: ${options}` : ''}`
              }).filter(Boolean).join('. ')
            } catch (e) { /* ignore malformed arguments */ }
            if (text) enqueue(hostItem('question', session, event, text, null))
          }
          return
        }
        if (type === 'approval/asked' && cfg.announceApprovals) {
          let text = String((event.data && event.data.reason) || '')
          if (cfg.stripApprovalPrefix) text = text.replace(/^escalate sandbox to danger-full-access\s*:\s*/i, '').trim()
          enqueue(hostItem('approval', session, event, text || 'An approval request needs your attention.', null))
          return
        }
        if (!event || type !== 'assistant/message' || !cfg.automaticSpeech || cfg.automaticSpeechMode !== 'background') return
        if (event.surfaceOp && event.surfaceOp !== 'append') return
        const message = event.data && event.data.message
        const text = visibleText(message)
        if (!text.trim()) return
        enqueue(hostItem('automatic', session, event, text, message && message.id))
      } catch (e) { log('session event speech error:', e.message) }
    })
  },
}
