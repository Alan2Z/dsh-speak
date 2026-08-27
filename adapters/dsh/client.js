'use strict'

// Browser half of dsh-speak: one replay control in each finalized assistant
// message's official action strip. Speech itself always remains on the Host.
window.__ModuleLoader__.load({
  id: 'dsh-speak',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')

    const CONTROL_PATH = '/dsh-speak/control'

    module.exports.inject = ['slots', 'timer']
    module.exports.apply = function apply(ctx) {
      let currentMessageId = null
      const listeners = new Set()

      function publish(messageId) {
        currentMessageId = typeof messageId === 'string' ? messageId : null
        for (const listener of listeners) listener()
      }

      async function control(payload) {
        const response = await fetch(CONTROL_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!response.ok) throw new Error(`dsh-speak control failed (${response.status})`)
        const state = await response.json()
        publish(state && state.speaking ? state.messageId : null)
      }

      function useSpeakingMessage() {
        const [messageId, setMessageId] = React.useState(currentMessageId)
        React.useEffect(() => {
          const update = () => setMessageId(currentMessageId)
          listeners.add(update)
          return () => listeners.delete(update)
        }, [])
        return messageId
      }

      function SpeakAction(props) {
        const messageId = props.messageId
        const text = props.useSession((snapshot) => {
          for (const node of snapshot.nodes) {
            if (node.kind !== 'assistant' || node.messageId !== messageId) continue
            return node.blocks
              .filter(block => block && block.kind === 'text' && typeof block.text === 'string')
              .map(block => block.text)
              .join('')
          }
          return ''
        })
        const speakingMessageId = useSpeakingMessage()
        const speaking = speakingMessageId === messageId
        const [pending, setPending] = React.useState(false)

        React.useEffect(() => {
          if (!speaking) return undefined
          return ctx.interval(() => {
            void control({ action: 'status' }).catch((error) => console.error(error))
          }, 500)
        }, [speaking])

        const label = speaking ? 'Stop speaking' : 'Speak message'
        const onClick = () => {
          if (pending || !text.trim()) return
          setPending(true)
          void control({ action: 'toggle', messageId, text })
            .catch((error) => console.error(error))
            .finally(() => setPending(false))
        }

        return React.createElement('button', {
          type: 'button',
          className: 'dsh-speak-message-action',
          'aria-label': label,
          'aria-pressed': speaking,
          'data-speaking': speaking || undefined,
          title: label,
          disabled: pending || !text.trim(),
          onClick,
        }, speaking ? '■' : '🔊')
      }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-speak'
        style.textContent = `
          .dsh-speak-message-action {
            display: inline-flex; align-items: center; justify-content: center;
            width: 28px; height: 28px; padding: 5px; border: 0;
            border-radius: 28px; background: transparent;
            color: var(--dsw-alias-label-tertiary); cursor: pointer;
            font: inherit; font-size: 14px; line-height: 1;
          }
          .dsh-speak-message-action:hover {
            background: var(--dsw-alias-interactive-bg-hover);
            color: var(--dsw-alias-label-secondary);
          }
          .dsh-speak-message-action[data-speaking] {
            color: var(--dsw-alias-label-primary);
          }
          .dsh-speak-message-action:disabled { cursor: default; opacity: .4; }
        `
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-speak message action styles')

      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'speak',
        order: 5,
        label: 'Speak',
      }, SpeakAction))
    }

    return module.exports
  },
})
