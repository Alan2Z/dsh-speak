'use strict'

// Browser half: assistant-message replay plus the native DSH plugin-settings card.
window.__ModuleLoader__.load({
  id: 'dsh-speak',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const { Button, DisclosureRow, IconPauseOutline16, Input } = require('@deepseek-ai/dsh-client-ui-primitives')
    const CONTROL_PATH = '/dsh-speak/control'
    const SETTINGS_NAMESPACE = 'dsh-speak'

    module.exports.inject = ['slots', 'timer', 'settingsScope']
    module.exports.apply = function apply(ctx) {
      let currentMessageId = null
      const listeners = new Set()
      const settings = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
      const e = React.createElement
      function IconVolume2({ size = 20, className }) {
        return e('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', className, 'aria-hidden': 'true' },
          e('path', { d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z' }),
          e('path', { d: 'M16 9a5 5 0 0 1 0 6' }),
          e('path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }),
        )
      }

      function publish(messageId) {
        currentMessageId = typeof messageId === 'string' ? messageId : null
        for (const listener of listeners) listener()
      }
      async function control(payload) {
        const response = await fetch(CONTROL_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        if (!response.ok) throw new Error(`dsh-speak control failed (${response.status})`)
        const state = await response.json()
        // Do not let a transient status response without an identity clear the
        // active message; the next poll supplies the authoritative association.
        if (state && state.speaking && state.messageId != null) publish(String(state.messageId))
        else if (!state || !state.speaking) publish(null)
      }
      // One shared status poll updates the small subscriber set below. The
      // message actions never own independent polling loops.
      ctx.effect(() => {
        const refresh = () => { void control({ action: 'status' }).catch(() => {}) }
        refresh()
        return ctx.interval(refresh, 250)
      }, 'dsh-speak speech status')
      function useSpeakingMessage() {
        const [messageId, setMessageId] = React.useState(currentMessageId)
        React.useEffect(() => { const update = () => setMessageId(currentMessageId); listeners.add(update); return () => listeners.delete(update) }, [])
        return messageId
      }
      function SpeakAction(props) {
        const messageId = props.messageId == null ? null : String(props.messageId)
        const text = props.useSession(snapshot => {
          for (const node of snapshot.nodes) if (node.kind === 'assistant' && node.messageId === messageId) {
            return node.blocks.filter(block => block && block.kind === 'text' && typeof block.text === 'string').map(block => block.text).join('')
          }
          return ''
        })
        const speaking = useSpeakingMessage() === messageId
        const [pending, setPending] = React.useState(false)
        const label = speaking ? 'Stop speaking' : 'Speak message'
        return e('button', {
          type: 'button', className: 'dsh-speak-message-action', 'aria-label': label, 'aria-pressed': speaking,
          'data-speaking': speaking || undefined, title: label, disabled: pending || !text.trim(),
          onClick: () => { if (!pending && text.trim()) { setPending(true); void control({ action: 'toggle', messageId, text }).catch(console.error).finally(() => setPending(false)) } },
        }, speaking ? e(IconPauseOutline16) : e(IconVolume2))
      }
      function useSettings() {
        const [snapshot, setSnapshot] = React.useState(settings.getSnapshot())
        React.useEffect(() => settings.subscribe(() => setSnapshot(settings.getSnapshot())), [])
        return snapshot
      }
      function Field({ label, hint, children, inline }) {
        return e('div', { className: 'dsh-speak-field' },
          inline
            ? e('div', { className: 'dsh-speak-inline-field' }, e('div', { className: 'dsh-speak-field-label' }, label), children)
            : e('div', { className: 'dsh-speak-field-label' }, label),
          inline ? null : children,
          e('p', { className: 'dsh-speak-field-hint' }, hint),
        )
      }
      function Toggle({ label, value, disabled, onChange, hint }) {
        return e(Field, { label: `${label}:`, hint, inline: true }, e('div', { className: 'dsh-speak-option-row' }, e(Button, { variant: 'outline', size: 'sm', disabled, 'aria-pressed': value, onClick: () => onChange(!value) }, value ? 'On' : 'Off')))
      }
      function SettingInput({ label, value, disabled, numeric, onChange, hint }) {
        const id = `dsh-speak-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        return e(Field, { label: `${label}:`, hint }, e('div', { className: 'dsh-speak-input-row' }, e(Input, { id, value: String(value), disabled, inputMode: numeric ? 'numeric' : undefined, onChange: event => onChange(event.target.value) })))
      }
      function Options({ label, value, disabled, onChange, hint, options }) {
        return e(Field, { label, hint }, e('div', { className: 'dsh-speak-option-row' }, ...options.map(option => e(Button, { key: option.value, variant: value === option.value ? 'primary' : 'outline', size: 'sm', disabled, 'aria-pressed': value === option.value, onClick: () => onChange(option.value) }, option.label))))
      }
      function MarkdownCleaning({ value, clean, disabled, set }) {
        const [open, setOpen] = React.useState(true)
        const controlsDisabled = disabled || !clean
        return e(DisclosureRow, {
          icon: null, title: 'Markdown cleaning', open, expandable: true,
          onToggle: () => setOpen(!open), expandOnRowClick: true,
        }, e('div', { style: { paddingLeft: '22px' } },
          e(Toggle, { label: 'Read Inline Code', value: value.readInlineCode !== false, disabled: controlsDisabled, onChange: next => set('readInlineCode', next), hint: 'Reads inline code without backtick markers.' }),
          e(Options, { label: 'Code Blocks', value: value.codeBlocks || 'smart', disabled: controlsDisabled, onChange: next => set('codeBlocks', next), hint: 'Choose how fenced code blocks are spoken.', options: [
            { value: 'all', label: 'Read all' }, { value: 'smart', label: 'Smart' }, { value: 'replace', label: 'Replace all' },
          ] }),
          e(SettingInput, { label: 'Code Block Max Characters', value: value.codeBlockMaxChars == null ? 300 : value.codeBlockMaxChars, numeric: true, disabled: controlsDisabled || value.codeBlocks !== 'smart', onChange: next => { if (/^\d+$/.test(next)) set('codeBlockMaxChars', Number(next)) }, hint: 'Only used by Smart code blocks.' }),
          e(SettingInput, { label: 'Code Block Replacement Text', value: value.codeBlockReplacementText || 'You can see the code in our history.', disabled: controlsDisabled || value.codeBlocks === 'all', onChange: next => set('codeBlockReplacementText', next), hint: 'Used when a code block is replaced.' }),
        ))
      }
      function SettingsCard() {
        const snapshot = useSettings()
        if (snapshot.status !== 'ready' || !snapshot.value) return null
        const value = snapshot.value
        const disabled = !snapshot.writable
        const clean = value.cleanMarkdownFormatting !== false
        const set = (field, next) => { void settings.set(field, next).catch(console.error) }
        return e('section', { 'aria-label': 'Speak settings' },
          e('h3', null, 'dsh-speak'),
          e('p', null, 'Speech preferences for automatic announcements and per-message replay.'),
          e(Toggle, { label: 'Automatic Speech', value: value.automaticSpeech !== false, disabled, onChange: next => set('automaticSpeech', next), hint: 'Speaks final assistant responses. Manual replay always remains available.' }),
          e(Toggle, { label: 'Clean Markdown Formatting', value: clean, disabled, onChange: next => set('cleanMarkdownFormatting', next), hint: 'Converts Markdown into natural speech text.' }),
          e(MarkdownCleaning, { value, clean, disabled, set }),
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
        style.textContent = '.dsh-speak-message-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:5px;border:0;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:14px;line-height:1}.dsh-speak-message-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}.dsh-speak-message-action[data-speaking]{color:var(--dsw-alias-label-primary)}.dsh-speak-message-action:disabled{cursor:default;opacity:.4}.dsh-speak-field{display:flex;flex-direction:column;gap:8px;margin:0 0 20px}.dsh-speak-field-label{font-weight:600;color:var(--dsw-alias-label-primary)}.dsh-speak-inline-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-speak-inline-field>.dsh-speak-field-label{flex:none}.dsh-speak-field-hint{margin:0;color:var(--dsw-alias-label-tertiary)}.dsh-speak-field+.dsh-speak-field{margin-top:20px}.dsh-speak-option-row{display:inline-flex;align-items:center;gap:8px;width:max-content;max-width:100%}.dsh-speak-input-row{display:flex;max-width:100%}.dsh-speak-input-row>span{max-width:100%}'
        document.head.appendChild(style); return () => style.remove()
      }, 'dsh-speak message action styles')
      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'speak', order: 5, label: 'Speak' }, SpeakAction))
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'speak', order: 25, label: 'Speak',
      }, SettingsCard))
    }
    return module.exports
  },
})
