// client.js — dsh-speak browser half: per-message Speak/Stop/Replay button,
// speech-state WebSocket, and the native dsh-speak settings page.
// ==============================================================================
// Merged bundle (1.7.0): victorwads' PR #2 UI (message action + Settings page,
// styled with @deepseek-ai/dsh-client-ui-primitives) plus the dsh-speak-specific
// options (master switch, optional event announcements, editable fixed prompt,
// queue-all-messages mode). All UI copy is bilingual (zh/en) via the DSH locale
// service; the settings page entry is "dsh-speak 设置 / dsh-speak settings".
//
// Host contract (adapters/dsh/speech-hook.js):
//   * /dsh-speak/control  — POST { action: 'play'|'stop'|'status', ... }
//   * /dsh-speak/ws       — WebSocket publishing { type: 'speech-state', ... }
//   * settings namespace 'dsh-speak' (installSettingsSection)
//
// The bundle is deliberately hand-written (no build step) and only uses
// platform seed modules + official primitives (bundle-purity gate).
'use strict'

window.__ModuleLoader__.load({
  id: 'dsh-speak',
  factory: require => {
    const module = { exports: {} }
    const React = require('react')
    const { Button, DisclosureRow, IconPauseOutline16, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
    const CONTROL_PATH = '/dsh-speak/control'
    const SOCKET_PATH = '/dsh-speak/ws'
    const SETTINGS_NAMESPACE = 'dsh-speak'

    // ---- locale copy (zh / en) -------------------------------------------
    const NS = 'dsh-speak'
    const zh = {
      nav: 'dsh-speak 设置',
      settingsAria: 'dsh-speak 设置',
      settingsIntro: '自动播报与逐条重播的语音偏好。',
      settingsTitle: 'dsh-speak',
      actionSpeakTurn: '播报此回合',
      actionStop: '停止播报',
      toggleOn: '开',
      toggleOff: '关',
      masterSwitch: '总开关',
      masterSwitchHint: '临时开启或关闭所有播报。',
      automaticSpeech: '自动朗读',
      automaticSpeechHint: '朗读最终回复。手动重播始终可用。',
      replayFullRead: '重播完整朗读',
      replayFullReadHint: '手动重播时跳过超长文本的标题截断，完整朗读。',
      queueAllMessages: '入队所有消息',
      queueAllMessagesHint: '每一条 assistant 消息到达即入队朗读（中间消息也读，FIFO），而不只读最终回复。',
      throttleMs: '合并延迟（毫秒）',
      throttleMsHint: '回复文本等待多久才播报（合并同一回复的多步消息）。',
      cleanMarkdown: '清理 Markdown',
      cleanMarkdownHint: '把 Markdown 转成自然的语音文本。',
      markdownCleaning: 'Markdown 清理',
      readInlineCode: '朗读行内代码',
      readInlineCodeHint: '朗读行内代码（去掉反引号标记）。',
      codeBlocks: '代码块',
      codeBlocksHint: '围栏代码块如何朗读。',
      codeBlocksAll: '全部朗读',
      codeBlocksSmart: '智能',
      codeBlocksReplace: '全部替换',
      codeBlockMaxChars: '代码块最大字数',
      codeBlockMaxCharsHint: '仅用于智能模式。',
      codeBlockReplacementText: '代码块替换文本',
      codeBlockReplacementTextHint: '代码块被替换时朗读的文本。',
      maxChars: '最大朗读字数',
      maxCharsHint: 'macOS 上 0 = 不限；Windows 保留安全默认值。',
      volume: '音量',
      volumeHint: '仅 Windows（0-100）；macOS 音量跟随系统。',
      rate: '语速',
      rateHintWin: 'Windows SAPI 语速（-10 到 10，0 = 正常；推荐 0，稍快 1-3）。',
      rateHintMac: 'words-per-minute（wpm），数值越大语速越快：默认 175，稍快 200。',
      engine: '引擎路径',
      engineHint: '自定义引擎脚本路径；留空自动解析（包内引擎 → ~/.dsh/hooks）。',
      longTextBehavior: '超长文本行为',
      longTextBehaviorHint: '超过正数上限时如何处理。',
      longTextMessageOption: '朗读替换提示语',
      longTextHeadingOption: '朗读最大标题',
      fixedPrompt: '固定提示语',
      fixedPromptHint: '超长文本（message 模式）时朗读的提示语。',
      announceApprovals: '播报审批',
      announceApprovalsHint: '朗读审批请求。',
      stripApprovalPrefix: '剥离审批前缀',
      stripApprovalPrefixHint: '剥离审批原因里的固定英文模板前缀（escalate sandbox to …: ）。',
      announceQuestions: '播报提问',
      announceQuestionsHint: '朗读 ask_user_question 问题。',
      questionGap: '问题间隔（毫秒）',
      questionGapHint: '多个问题播报之间的停顿。',
      optionalEvents: '可选事件播报',
      turnEnd: '回合结束',
      turnEndHint: '一轮对话结束时播报。',
      commandDone: '命令完成',
      commandDoneHint: '命令完成或失败时播报。',
      goalChange: '目标变更',
      goalChangeHint: '目标创建/更新/完成时播报。',
      toolErrors: '工具出错',
      toolErrorsHint: '工具调用失败时播报错误摘要。',
      todoWrite: '待办更新',
      todoWriteHint: 'agent 更新待办列表时播报。',
    }
    const en = {
      nav: 'dsh-speak settings',
      settingsAria: 'dsh-speak settings',
      settingsIntro: 'Speech preferences for automatic announcements and per-message replay.',
      settingsTitle: 'dsh-speak',
      actionSpeakTurn: 'Speak turn',
      actionStop: 'Stop speaking',
      toggleOn: 'On',
      toggleOff: 'Off',
      masterSwitch: 'Master Switch',
      masterSwitchHint: 'Temporarily enable or disable all announcements.',
      automaticSpeech: 'Automatic Speech',
      automaticSpeechHint: 'Speaks final assistant responses. Manual replay always remains available.',
      replayFullRead: 'Full Read on Replay',
      replayFullReadHint: 'When replaying, read the full text instead of the heading fallback.',
      queueAllMessages: 'Queue All Messages',
      queueAllMessagesHint: 'Also speaks intermediate assistant messages in a FIFO queue, not only the final reply.',
      throttleMs: 'Merge Delay (ms)',
      throttleMsHint: 'How long a reply waits before being announced (merges multi-step messages).',
      cleanMarkdown: 'Clean Markdown Formatting',
      cleanMarkdownHint: 'Converts Markdown into natural speech text.',
      markdownCleaning: 'Markdown cleaning',
      readInlineCode: 'Read Inline Code',
      readInlineCodeHint: 'Reads inline code without backtick markers.',
      codeBlocks: 'Code Blocks',
      codeBlocksHint: 'Choose how fenced code blocks are spoken.',
      codeBlocksAll: 'Read all',
      codeBlocksSmart: 'Smart',
      codeBlocksReplace: 'Replace all',
      codeBlockMaxChars: 'Code Block Max Characters',
      codeBlockMaxCharsHint: 'Only used by Smart code blocks.',
      codeBlockReplacementText: 'Code Block Replacement Text',
      codeBlockReplacementTextHint: 'Used when a code block is replaced.',
      maxChars: 'Max Speech Characters',
      maxCharsHint: '0 is unlimited on macOS; Windows keeps its safe default.',
      volume: 'Volume',
      volumeHint: 'Windows only (0-100); macOS volume follows the system.',
      rate: 'Speech Rate',
      rateHintWin: 'Windows SAPI rate scale (-10 to 10, 0 = normal; try 1-3 for faster).',
      rateHintMac: 'words-per-minute (wpm) — higher = faster: default 175, 200 is a bit faster.',
      engine: 'Engine Path',
      engineHint: 'Custom engine script path; empty = auto-resolve (package engine → ~/.dsh/hooks).',
      longTextBehavior: 'Long Text Behavior',
      longTextBehaviorHint: 'When a positive maximum is exceeded.',
      longTextMessageOption: 'Read replacement message',
      longTextHeadingOption: 'Read largest heading',
      fixedPrompt: 'Fixed Prompt',
      fixedPromptHint: 'The prompt spoken when the text is too long (message mode).',
      announceApprovals: 'Announce Approvals',
      announceApprovalsHint: 'Announces approval requests.',
      stripApprovalPrefix: 'Strip Approval Prefix',
      stripApprovalPrefixHint: 'Strip the fixed English template prefix (escalate sandbox to …:) from approval reasons.',
      announceQuestions: 'Announce Questions',
      announceQuestionsHint: 'Announces ask-user questions.',
      questionGap: 'Question Gap (ms)',
      questionGapHint: 'Pause between multiple question announcements.',
      optionalEvents: 'Optional event announcements',
      turnEnd: 'Turn End',
      turnEndHint: 'Announces when a round of conversation ends.',
      commandDone: 'Command Done',
      commandDoneHint: 'Announces when a command finishes or fails.',
      goalChange: 'Goal Change',
      goalChangeHint: 'Announces goal created/updated/completed.',
      toolErrors: 'Tool Errors',
      toolErrorsHint: 'Announces an error summary when a tool call fails.',
      todoWrite: 'Todo Write',
      todoWriteHint: 'Announces when the agent updates its todos.',
    }

    module.exports.inject = ['slots', 'timer', 'settingsScope', 'locale']
    module.exports.apply = function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-speak: dictionaries')
      const t = ctx.locale.bind(NS)

      let speechState = { speaking: false, sessionId: null, turn: null, messageId: null, source: null, queueLength: 0 }
      const listeners = new Set()
      const settings = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
      const e = React.createElement
      function IconVolume2({ size = 20, className }) {
        return e('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', className, 'aria-hidden': 'true' },
          e('path', { d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z' }),
          e('path', { d: 'M16 9a5 5 0 0 1 0 6' }), e('path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }),
        )
      }
      function publish(next) {
        speechState = next && typeof next === 'object' ? next : { speaking: false, sessionId: null, turn: null, messageId: null, source: null, queueLength: 0 }
        for (const listener of listeners) listener()
      }
      async function control(payload) {
        const response = await fetch(CONTROL_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        if (!response.ok) throw new Error(`dsh-speak control failed (${response.status})`)
        const state = await response.json()
        if (state && state.type === 'speech-state') publish(state)
        return state
      }
      ctx.effect(() => {
        let socket = null
        let retry = null
        let disposed = false
        const connect = () => {
          if (disposed) return
          const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
          socket = new WebSocket(`${scheme}//${location.host}${SOCKET_PATH}`)
          socket.onmessage = event => {
            try {
              const state = JSON.parse(event.data)
              if (state && state.type === 'speech-state') publish(state)
            } catch (e) { console.warn('[dsh-speak] ignored invalid speech websocket state') }
          }
          socket.onclose = () => {
            if (!disposed) retry = ctx.timeout(connect, 1000)
          }
          socket.onerror = () => { try { socket.close() } catch (e) { /* closed */ } }
        }
        connect()
        return () => {
          disposed = true
          if (retry) retry()
          try { if (socket) socket.close() } catch (e) { /* closed */ }
        }
      }, 'dsh-speak speech state websocket')
      function useSpeechState() {
        const [snapshot, setSnapshot] = React.useState(speechState)
        React.useEffect(() => { const update = () => setSnapshot(speechState); listeners.add(update); return () => listeners.delete(update) }, [])
        return snapshot
      }
      function visibleText(node) {
        return Array.isArray(node && node.blocks) ? node.blocks.filter(block => block && block.kind === 'text' && typeof block.text === 'string').map(block => block.text).join('') : ''
      }
      function SpeakAction(props) {
        const messageId = props.messageId == null ? null : String(props.messageId)
        const turnData = props.useSession(snapshot => {
          // DSH 会话投影：snapshot.chat.nodes 是按 key 索引的 Map，value 为
          // { key, kind, data, location }。最终 assistant 消息内容在节点的
          // data.finalNode（assistant 节点）或 data.closing.finalNode
          // （turn-tail 节点）里，含 messageId / turn / seq / blocks。
          const nodes = snapshot && snapshot.chat && snapshot.chat.nodes
          if (!nodes || typeof nodes.values !== 'function') return { turn: null, text: '' }
          const all = [...nodes.values()]
          const finalOf = node => {
            const d = node && node.data
            if (!d) return null
            if (d.finalNode) return d.finalNode
            if (d.closing && d.closing.finalNode) return d.closing.finalNode
            return d.kind === 'assistant' ? d : null
          }
          const entries = all.map(node => ({ final: finalOf(node) }))
          const addressed = entries.find(entry => entry.final && String(entry.final.messageId) === messageId)
          if (!addressed || !Number.isFinite(addressed.final.turn)) return { turn: null, text: '' }
          const turn = addressed.final.turn
          // 只重播点击的那条消息（assistant-actions 只渲染在回合尾部 = 最终回复），
          // 不合并整个回合的所有中间消息
          const text = visibleText(addressed.final)
          return { turn, text }
        })
        const active = useSpeechState()
        const speaking = active.speaking && String(active.sessionId) === String(props.sessionId) && active.turn === turnData.turn
        const [pending, setPending] = React.useState(false)
        const label = speaking ? t('actionStop') : t('actionSpeakTurn')
        return e('button', {
          type: 'button', className: 'dsh-speak-message-action', 'aria-label': label, 'aria-pressed': speaking,
          'data-speaking': speaking || undefined, title: label, disabled: pending || !turnData.text.trim(),
          onClick: () => {
            if (pending) return
            setPending(true)
            const action = speaking ? 'stop' : 'play'
            const payload = speaking ? { action } : { action, sessionId: props.sessionId, turn: turnData.turn, messageId, text: turnData.text }
            void control(payload).catch(console.error).finally(() => setPending(false))
          },
        }, speaking ? e(IconPauseOutline16) : e(IconVolume2))
      }
      function useSettings() {
        const [snapshot, setSnapshot] = React.useState(settings.getSnapshot())
        React.useEffect(() => settings.subscribe(() => setSnapshot(settings.getSnapshot())), [])
        return snapshot
      }
      function Field({ label, hint, children, inline }) {
        return e('div', { className: 'dsh-speak-field' }, inline ? e('div', { className: 'dsh-speak-inline-field' }, e('div', { className: 'dsh-speak-field-label' }, label), children) : e('div', { className: 'dsh-speak-field-label' }, label), inline ? null : children, e('p', { className: 'dsh-speak-field-hint' }, hint))
      }
      function Toggle({ label, value, disabled, onChange, hint }) { return e(Field, { label: `${label}:`, hint, inline: true }, e('div', { className: 'dsh-speak-option-row' }, e(Button, { variant: 'outline', size: 'sm', disabled, 'aria-pressed': value, onClick: () => onChange(!value) }, value ? t('toggleOn') : t('toggleOff')))) }
      function SettingInput({ label, value, disabled, numeric, onChange, hint }) {
        const id = `dsh-speak-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        // 缓冲输入：受控 value 来自配置，直接绑定会让"-"这类中间态被弹回
        // （Number('-') = NaN 拒绝后 value 不变），负数字段无法输入。这里用
        // 局部 state 缓冲，输入过程自由，onChange 里校验合法后才写配置。
        const [text, setText] = React.useState(String(value))
        React.useEffect(() => { setText(String(value)) }, [value])
        return e(Field, { label: `${label}:`, hint }, e('div', { className: 'dsh-speak-input-row' }, e(Input, { id, value: text, disabled, inputMode: numeric ? 'numeric' : undefined, onChange: event => { setText(event.target.value); onChange(event.target.value) } })))
      }
      function Options({ label, value, disabled, onChange, hint, options }) { return e(Field, { label, hint }, e('div', { className: 'dsh-speak-option-row' }, ...options.map(option => e(Button, { key: option.value, variant: value === option.value ? 'primary' : 'outline', size: 'sm', disabled, 'aria-pressed': value === option.value, onClick: () => onChange(option.value) }, option.label)))) }
      function MarkdownCleaning({ value, clean, disabled, set }) {
        const [open, setOpen] = React.useState(true); const controlsDisabled = disabled || !clean
        return e(DisclosureRow, { icon: null, title: t('markdownCleaning'), open, expandable: true, onToggle: () => setOpen(!open), expandOnRowClick: true }, e('div', { style: { paddingLeft: '22px' } },
          e(Toggle, { label: t('readInlineCode'), value: value.readInlineCode !== false, disabled: controlsDisabled, onChange: next => set('readInlineCode', next), hint: t('readInlineCodeHint') }),
          e(Options, { label: t('codeBlocks'), value: value.codeBlocks || 'smart', disabled: controlsDisabled, onChange: next => set('codeBlocks', next), hint: t('codeBlocksHint'), options: [{ value: 'all', label: t('codeBlocksAll') }, { value: 'smart', label: t('codeBlocksSmart') }, { value: 'replace', label: t('codeBlocksReplace') }] }),
          e(SettingInput, { label: t('codeBlockMaxChars'), value: value.codeBlockMaxChars == null ? 300 : value.codeBlockMaxChars, numeric: true, disabled: controlsDisabled || value.codeBlocks !== 'smart', onChange: next => { if (/^\d+$/.test(next)) set('codeBlockMaxChars', Number(next)) }, hint: t('codeBlockMaxCharsHint') }),
          e(SettingInput, { label: t('codeBlockReplacementText'), value: value.codeBlockReplacementText || 'You can see the code in our history.', disabled: controlsDisabled || value.codeBlocks === 'all', onChange: next => set('codeBlockReplacementText', next), hint: t('codeBlockReplacementTextHint') }),
        ))
      }
      function SettingsCard() {
        // hooks must run unconditionally (before the ready-guard return)
        const [eventsOpen, setEventsOpen] = React.useState(false)
        const snapshot = useSettings(); if (snapshot.status !== 'ready' || !snapshot.value) return null
        const value = snapshot.value; const disabled = !snapshot.writable; const clean = value.cleanMarkdownFormatting !== false; const set = (field, next) => { void settings.set(field, next).catch(console.error) }
        const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || navigator.platform || '')
        return e('section', { 'aria-label': t('settingsAria') }, e('h3', null, t('settingsTitle')), e('p', null, t('settingsIntro')),
          e(Toggle, { label: t('masterSwitch'), value: value.enabled !== false, disabled, onChange: next => set('enabled', next), hint: t('masterSwitchHint') }),
          e(Toggle, { label: t('automaticSpeech'), value: value.automaticSpeech !== false, disabled, onChange: next => set('automaticSpeech', next), hint: t('automaticSpeechHint') }),
          e(Toggle, { label: t('replayFullRead'), value: value.replayFullRead === true, disabled, onChange: next => set('replayFullRead', next), hint: t('replayFullReadHint') }),
          e(Toggle, { label: t('queueAllMessages'), value: value.queueAllMessages === true, disabled: disabled || value.automaticSpeech === false, onChange: next => set('queueAllMessages', next), hint: t('queueAllMessagesHint') }),
          e(SettingInput, { label: t('throttleMs'), value: value.throttleMs == null ? 1500 : value.throttleMs, numeric: true, disabled, onChange: next => { if (/^\d+$/.test(next)) set('throttleMs', Number(next)) }, hint: t('throttleMsHint') }),
          e(Toggle, { label: t('cleanMarkdown'), value: clean, disabled, onChange: next => set('cleanMarkdownFormatting', next), hint: t('cleanMarkdownHint') }), e(MarkdownCleaning, { value, clean, disabled, set }),
          e(SettingInput, { label: t('maxChars'), value: value.maxChars == null ? 0 : value.maxChars, numeric: true, disabled, onChange: next => { if (/^\d+$/.test(next)) set('maxChars', Number(next)) }, hint: t('maxCharsHint') }),
          e(SettingInput, { label: t('volume'), value: value.volume == null ? 50 : value.volume, numeric: true, disabled, onChange: next => { if (/^\d+$/.test(next)) set('volume', Number(next)) }, hint: t('volumeHint') }),
          e(SettingInput, { label: t('rate'), value: value.rate == null ? 0 : value.rate, numeric: true, disabled, onChange: next => { if (/^-?\d*\.?\d*$/.test(next)) { const n = Number(next); if (Number.isFinite(n)) set('rate', n) } }, hint: isMac ? t('rateHintMac') : t('rateHintWin') }),
          e(SettingInput, { label: t('engine'), value: value.engine || '', disabled, onChange: next => set('engine', next), hint: t('engineHint') }),
          e(Options, { label: t('longTextBehavior'), value: value.longTextMode || 'message', disabled, onChange: next => set('longTextMode', next), hint: t('longTextBehaviorHint'), options: [{ value: 'message', label: t('longTextMessageOption') }, { value: 'heading', label: t('longTextHeadingOption') }] }),
          e(SettingInput, { label: t('fixedPrompt'), value: value.longTextMessage || '本次播报内容较长，请自行阅读。', disabled: disabled || value.longTextMode !== 'message', onChange: next => set('longTextMessage', next), hint: t('fixedPromptHint') }),
          e(Toggle, { label: t('announceApprovals'), value: value.announceApprovals !== false, disabled, onChange: next => set('announceApprovals', next), hint: t('announceApprovalsHint') }),
          e(Toggle, { label: t('stripApprovalPrefix'), value: value.stripApprovalPrefix !== false, disabled: disabled || value.announceApprovals === false, onChange: next => set('stripApprovalPrefix', next), hint: t('stripApprovalPrefixHint') }),
          e(Toggle, { label: t('announceQuestions'), value: value.announceQuestions !== false, disabled, onChange: next => set('announceQuestions', next), hint: t('announceQuestionsHint') }),
          e(SettingInput, { label: t('questionGap'), value: value.questionGapMs == null ? 2000 : value.questionGapMs, numeric: true, disabled: disabled || value.announceQuestions === false, onChange: next => { if (/^\d+$/.test(next)) set('questionGapMs', Number(next)) }, hint: t('questionGapHint') }),
          e(DisclosureRow, { icon: null, title: t('optionalEvents'), open: eventsOpen, expandable: true, onToggle: () => setEventsOpen(!eventsOpen), expandOnRowClick: true }, e('div', { style: { paddingLeft: '22px' } },
            e(Toggle, { label: t('turnEnd'), value: value.announceTurnEnd === true, disabled, onChange: next => set('announceTurnEnd', next), hint: t('turnEndHint') }),
            e(Toggle, { label: t('commandDone'), value: value.announceCommandDone === true, disabled, onChange: next => set('announceCommandDone', next), hint: t('commandDoneHint') }),
            e(Toggle, { label: t('goalChange'), value: value.announceGoalChange === true, disabled, onChange: next => set('announceGoalChange', next), hint: t('goalChangeHint') }),
            e(Toggle, { label: t('toolErrors'), value: value.announceToolErrors === true, disabled, onChange: next => set('announceToolErrors', next), hint: t('toolErrorsHint') }),
            e(Toggle, { label: t('todoWrite'), value: value.announceTodoWrite === true, disabled, onChange: next => set('announceTodoWrite', next), hint: t('todoWriteHint') }),
          )),
        )
      }
      ctx.effect(() => {
        const style = document.createElement('style'); style.dataset.plugin = 'dsh-speak'
        style.textContent = '.dsh-speak-message-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:5px;border:0;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:14px;line-height:1}.dsh-speak-message-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.dsh-speak-message-action[data-speaking]{color:var(--dsw-alias-label-primary)}.dsh-speak-message-action:disabled{cursor:default;opacity:.4}.dsh-speak-field{display:flex;flex-direction:column;gap:8px;margin:0 0 20px}.dsh-speak-field-label{font-weight:600;color:var(--dsw-alias-label-primary)}.dsh-speak-inline-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-speak-inline-field>.dsh-speak-field-label{flex:none}.dsh-speak-field-hint{margin:0;color:var(--dsw-alias-label-tertiary)}.dsh-speak-field+.dsh-speak-field{margin-top:20px}.dsh-speak-option-row{display:inline-flex;align-items:center;gap:8px;width:max-content;max-width:100%}.dsh-speak-input-row{display:flex;max-width:100%}.dsh-speak-input-row>span{max-width:100%}'
        document.head.appendChild(style); return () => style.remove()
      }, 'dsh-speak message action styles')
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'speak', order: 5, label: 'Speak', locale: NS }, SpeakAction))
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'speak', order: 25, label: () => t('nav'), locale: NS }, SettingsCard))
    }
    return module.exports
  },
})
