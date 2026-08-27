'use strict'

// Browser half: assistant-message replay plus the native DSH plugin-settings card.
window.__ModuleLoader__.load({
  id: 'dsh-speak',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { Button, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
    const CONTROL_PATH = '/dsh-speak/control'
    const SETTINGS_NAMESPACE = 'dsh-speak'

    module.exports.inject = ['slots', 'timer', 'settingsScope']
    module.exports.apply = function apply(ctx) {
      let currentMessageId = null
      const listeners = new Set()
      const settings = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
      const e = React.createElement

      function publish(messageId) {
        currentMessageId = typeof messageId === 'string' ? messageId : null
        for (const listener of listeners) listener()
      }
      async function control(payload) {
        const response = await fetch(CONTROL_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        if (!response.ok) throw new Error(`dsh-speak control failed (${response.status})`)
        const state = await response.json()
        publish(state && state.speaking ? state.messageId : null)
      }
      function useSpeakingMessage() {
        const [messageId, setMessageId] = React.useState(currentMessageId)
        React.useEffect(() => { const update = () => setMessageId(currentMessageId); listeners.add(update); return () => listeners.delete(update) }, [])
        return messageId
      }
      function SpeakAction(props) {
        const messageId = props.messageId
        const text = props.useSession(snapshot => {
          for (const node of snapshot.nodes) if (node.kind === 'assistant' && node.messageId === messageId) {
            return node.blocks.filter(block => block && block.kind === 'text' && typeof block.text === 'string').map(block => block.text).join('')
          }
          return ''
        })
        const speaking = useSpeakingMessage() === messageId
        const [pending, setPending] = React.useState(false)
        React.useEffect(() => speaking ? ctx.interval(() => { void control({ action: 'status' }).catch(console.error) }, 500) : undefined, [speaking])
        const label = speaking ? 'Stop speaking' : 'Speak message'
        return e('button', {
          type: 'button', className: 'dsh-speak-message-action', 'aria-label': label, 'aria-pressed': speaking,
          'data-speaking': speaking || undefined, title: label, disabled: pending || !text.trim(),
          onClick: () => { if (!pending && text.trim()) { setPending(true); void control({ action: 'toggle', messageId, text }).catch(console.error).finally(() => setPending(false)) } },
        }, speaking ? '■' : '🔊')
      }
      function useSettings() {
        const [snapshot, setSnapshot] = React.useState(settings.getSnapshot())
        React.useEffect(() => settings.subscribe(() => setSnapshot(settings.getSnapshot())), [])
        return snapshot
      }
      function Toggle({ label, value, disabled, onChange, hint }) {
        return e('div', null,
          e('strong', null, label),
          e('p', null, hint),
          e(Button, { variant: 'outline', size: 'sm', disabled, 'aria-pressed': value, onClick: () => onChange(!value) }, value ? 'On' : 'Off'),
        )
      }
      function SettingInput({ label, value, disabled, numeric, onChange, hint }) {
        return e('label', null,
          e('strong', null, label),
          e('p', null, hint),
          e(Input, { value: String(value), disabled, inputMode: numeric ? 'numeric' : undefined, onChange: event => onChange(event.target.value) }),
        )
      }
      function Options({ label, value, disabled, onChange, hint, options }) {
        return e('div', null,
          e('strong', null, label), e('p', null, hint),
          ...options.map(option => e(Button, { key: option.value, variant: value === option.value ? 'primary' : 'outline', size: 'sm', disabled, 'aria-pressed': value === option.value, onClick: () => onChange(option.value) }, option.label)),
        )
      }
      function SettingsCard() {
        const snapshot = useSettings()
        if (snapshot.status !== 'ready' || !snapshot.value) return null
        const value = snapshot.value
        const disabled = !snapshot.writable
        const clean = value.cleanMarkdownFormatting !== false
        const set = (field, next) => { void settings.set(field, next).catch(console.error) }
        return e('li', null,
          e('h3', null, 'dsh-speak'),
          e('p', null, 'Speech preferences for automatic announcements and per-message replay.'),
          e(Toggle, { label: 'Automatic Speech', value: value.automaticSpeech !== false, disabled, onChange: next => set('automaticSpeech', next), hint: 'Speaks final assistant responses. Manual replay always remains available.' }),
          e(Toggle, { label: 'Clean Markdown Formatting', value: clean, disabled, onChange: next => set('cleanMarkdownFormatting', next), hint: 'Converts Markdown into natural speech text.' }),
          e('fieldset', { disabled: disabled || !clean },
            e('legend', null, 'Markdown cleaning'),
            e(Toggle, { label: 'Read Inline Code', value: value.readInlineCode !== false, disabled: disabled || !clean, onChange: next => set('readInlineCode', next), hint: 'Reads inline code without backtick markers.' }),
            e(Options, { label: 'Code Blocks', value: value.codeBlocks || 'smart', disabled: disabled || !clean, onChange: next => set('codeBlocks', next), hint: 'Choose how fenced code blocks are spoken.', options: [
              { value: 'all', label: 'Read all' }, { value: 'smart', label: 'Smart' }, { value: 'replace', label: 'Replace all' },
            ] }),
            e(SettingInput, { label: 'Code Block Max Characters', value: value.codeBlockMaxChars == null ? 300 : value.codeBlockMaxChars, numeric: true, disabled: disabled || !clean || value.codeBlocks !== 'smart', onChange: next => { if (/^\d+$/.test(next)) set('codeBlockMaxChars', Number(next)) }, hint: 'Only used by Smart code blocks.' }),
            e(SettingInput, { label: 'Code Block Replacement Text', value: value.codeBlockReplacementText || 'You can see the code in our history.', disabled: disabled || !clean || value.codeBlocks === 'all', onChange: next => set('codeBlockReplacementText', next), hint: 'Used when a code block is replaced.' }),
          ),
          e(SettingInput, { label: 'Max Speech Characters', value: value.maxChars == null ? 0 : value.maxChars, numeric: true, disabled, onChange: next => { if (/^\d+$/.test(next)) set('maxChars', Number(next)) }, hint: '0 is unlimited on macOS; Windows keeps its safe default.' }),
          e(Options, { label: 'Long Text Behavior', value: value.longTextMode || 'message', disabled, onChange: next => set('longTextMode', next), hint: 'When a positive maximum is exceeded.', options: [
            { value: 'message', label: 'Read replacement message' }, { value: 'heading', label: 'Read largest heading' },
          ] }),
          e(Toggle, { label: 'Announce Approvals', value: value.announceApprovals !== false, disabled, onChange: next => set('announceApprovals', next), hint: 'Announces approval requests.' }),
          e(Toggle, { label: 'Announce Questions', value: value.announceQuestions !== false, disabled, onChange: next => set('announceQuestions', next), hint: 'Announces ask-user questions.' }),
        )
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-speak'
        style.textContent = '.dsh-speak-message-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:5px;border:0;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:14px;line-height:1}.dsh-speak-message-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.dsh-speak-message-action[data-speaking]{color:var(--dsw-alias-label-primary)}.dsh-speak-message-action:disabled{cursor:default;opacity:.4}'
        document.head.appendChild(style); return () => style.remove()
      }, 'dsh-speak message action styles')
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'speak', order: 5, label: 'Speak' }, SpeakAction))
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({ name: 'settings.plugin.item', key: SETTINGS_NAMESPACE }, SettingsCard))
    }
    return module.exports
  },
})
