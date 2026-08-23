// client.js — dsh-speak browser half: a settings card for 设置 → 插件 → 插件配置
// ==============================================================================
// Registers a card into the `settings.plugin.item` slot keyed by the `dsh-speak`
// settings namespace (registered Host-side by adapters/dsh/speech-hook.js via
// installSettingsSection). The card reads/writes the namespace through the
// client `settingsScope` service, so every option the Host plugin honors is
// visible and editable here — no hand-edited YAML needed.
//
// This file is a DSH client bundle: `window.__ModuleLoader__.load({ id,
// factory })`. It is deliberately handwritten (no build step) — it only uses
// the platform seed modules (react, the slots/locale/settingsScope services)
// and follows the same contract as the built bundles.
//
// Card contract (see dsh-client-ui-settings-plugins):
//   * a plugin that ships a browser half owns its own card; importing a value
//     from dsh-client-ui-settings-plugins would fail the client bundle-purity
//     gate, so all chrome is drawn here
//   * the card shows the resolved value (user layer over composition base over
//     schema default), marks overridden fields, and writes through the scope
'use strict'

window.__ModuleLoader__.load({
  id: 'dsh-speak',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')
    const { createElement: h, useState, useSyncExternalStore } = react

    // settings namespace — must match the Host-side registration
    const NS = 'dsh-speak'
    // services this browser plugin needs
    const inject = ['slots', 'locale']

    // ---------------------------------------------------------------------
    // locale copy
    // ---------------------------------------------------------------------
    const zh = {
      cardTitle: '语音播报',
      cardDescription: 'dsh-speak — 让 agent 在长任务完成时开口告诉你。',
      readOnly: '本部署的设置为只读。',
      unsaved: '未保存',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      saveFailed: '本部署没有接受这些值，已保留供你修改。',
      overridden: '已覆盖',
      reset: '恢复默认',
      fieldThrottleMs: '播报延迟（毫秒）',
      hintThrottleMs: '回复文本等待多久才播报（合并同一回复的多步消息）。',
      fieldEngine: '引擎路径覆盖',
      hintEngine: '留空自动解析：包内 engine → ~/.dsh/hooks。',
      fieldAnnounceApprovals: '播报审批请求',
      hintAnnounceApprovals: 'agent 等你操作时播"需要你的审批"。',
      hintDependsOnApprovals: '需先开启「播报审批请求」。',
      fieldAnnounceQuestions: '播报提问',
      hintAnnounceQuestions: '播报 ask_user_question 的问题与选项。',
      fieldStripApprovalPrefix: '剥离审批前缀',
      hintStripApprovalPrefix: '剥离审批原因里的 "escalate sandbox to …" 前缀。',
      fieldLongTextMode: '超长文本模式',
      hintLongTextMode: 'message = 念固定提示语；heading = 念最大字号标题。',
      fieldLongTextMessage: '固定提示语',
      hintLongTextMessage: '超长文本时朗读的提示语内容。',
      fieldEnabled: '朗读总开关',
      hintEnabled: '可以临时开启或关闭朗读效果。',
      fieldMaxChars: '单次朗读字数上限',
      hintMaxChars: '超过此长度改念提示语（SAPI 超出会静默失败）。',
      fieldVolume: '音量（仅 Windows）',
      hintVolume: '0-100；macOS 音量跟随系统。',
      fieldRate: '语速',
      hintRate: '0 = 引擎默认（Windows SAPI 刻度 / macOS wpm）。',
      fieldAnnounceTurnEnd: '回合结束播报',
      hintAnnounceTurnEnd: 'turn/end — 一轮对话结束时播报。',
      fieldAnnounceCommandDone: '命令完成播报',
      hintAnnounceCommandDone: 'command/done — agent 的命令执行完成/失败时播报。',
      fieldAnnounceGoalChange: '目标变更播报',
      hintAnnounceGoalChange: 'goal/change — 目标创建/更新/完成时播报。',
      fieldAnnounceToolErrors: '工具出错播报',
      hintAnnounceToolErrors: 'tool/result — 工具调用返回错误时播报摘要。',
      fieldAnnounceTodoWrite: '待办更新播报',
      hintAnnounceTodoWrite: 'todo/write — agent 更新待办列表时播报。',
      booleanTrue: '开',
      booleanFalse: '关',
      selectMessage: 'message（固定提示语）',
      selectHeading: 'heading（最大标题）',
      expand: '展开设置',
      collapse: '收起设置',
      unsaved: '未保存',
      pending: '未保存',
    }
    const en = {
      cardTitle: 'Voice announcements',
      cardDescription: 'dsh-speak — let your agent tell you when a long task is done.',
      readOnly: 'This deployment stores settings read-only.',
      unsaved: 'Unsaved',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard',
      saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
      overridden: 'Overridden',
      reset: 'Reset to default',
      fieldThrottleMs: 'Announce delay (ms)',
      hintThrottleMs: 'How long a reply waits before being announced (merges multi-step messages).',
      fieldEngine: 'Engine path override',
      hintEngine: 'Blank auto-resolves: package engine → ~/.dsh/hooks.',
      fieldAnnounceApprovals: 'Announce approval requests',
      hintAnnounceApprovals: 'Speaks "需要你的审批" when the agent waits on you.',
      hintDependsOnApprovals: 'Requires "Announce approval requests" to be on.',
      fieldAnnounceQuestions: 'Announce questions',
      hintAnnounceQuestions: 'Speaks ask_user_question content and options.',
      fieldStripApprovalPrefix: 'Strip approval prefix',
      hintStripApprovalPrefix: 'Strips the "escalate sandbox to …" prefix from approval reasons.',
      fieldLongTextMode: 'Long-text mode',
      hintLongTextMode: 'message = fixed prompt; heading = largest markdown heading.',
      fieldLongTextMessage: 'Fixed prompt',
      hintLongTextMessage: 'The prompt spoken for over-long text.',
      fieldEnabled: 'Voice announcements master switch',
      hintEnabled: 'Temporarily enable or disable all announcements.',
      fieldMaxChars: 'Per-utterance character ceiling',
      hintMaxChars: 'Beyond this, a prompt is spoken instead (SAPI fails silently).',
      fieldVolume: 'Volume (Windows only)',
      hintVolume: '0-100; macOS volume follows the system.',
      fieldRate: 'Speech rate',
      hintRate: '0 = engine default (Windows SAPI scale / macOS wpm).',
      fieldAnnounceTurnEnd: 'Announce turn end',
      hintAnnounceTurnEnd: 'turn/end — announced when a round of conversation ends.',
      fieldAnnounceCommandDone: 'Announce command done',
      hintAnnounceCommandDone: 'command/done — announced when an agent command finishes/fails.',
      fieldAnnounceGoalChange: 'Announce goal changes',
      hintAnnounceGoalChange: 'goal/change — announced when a goal is created/updated/completed.',
      fieldAnnounceToolErrors: 'Announce tool errors',
      hintAnnounceToolErrors: 'tool/result — announced when a tool call returns an error.',
      fieldAnnounceTodoWrite: 'Announce todo updates',
      hintAnnounceTodoWrite: 'todo/write — announced when the agent updates its todo list.',
      booleanTrue: 'On',
      booleanFalse: 'Off',
      selectMessage: 'message (fixed prompt)',
      selectHeading: 'heading (largest heading)',
      expand: 'Show settings',
      collapse: 'Hide settings',
      unsaved: 'Unsaved',
      pending: 'Unsaved',
    }

    // ---------------------------------------------------------------------
    // field model: every option the Host plugin honors, rendered generically
    // ---------------------------------------------------------------------
    // kind: 'boolean' | 'number' | 'text' | 'select'; number fields carry a step
    const FIELDS = [
      { key: 'enabled', kind: 'boolean', label: 'fieldEnabled', hint: 'hintEnabled' },
      { key: 'throttleMs', kind: 'number', label: 'fieldThrottleMs', hint: 'hintThrottleMs', step: 100 },
      { key: 'engine', kind: 'text', label: 'fieldEngine', hint: 'hintEngine' },
      { key: 'announceApprovals', kind: 'boolean', label: 'fieldAnnounceApprovals', hint: 'hintAnnounceApprovals' },
      { key: 'stripApprovalPrefix', kind: 'boolean', label: 'fieldStripApprovalPrefix', hint: 'hintStripApprovalPrefix', dependsOn: 'announceApprovals' },
      { key: 'announceQuestions', kind: 'boolean', label: 'fieldAnnounceQuestions', hint: 'hintAnnounceQuestions' },
      { key: 'longTextMode', kind: 'select', label: 'fieldLongTextMode', hint: 'hintLongTextMode', options: ['message', 'heading'] },
      { key: 'longTextMessage', kind: 'text', label: 'fieldLongTextMessage', hint: 'hintLongTextMessage', showWhen: { key: 'longTextMode', value: 'message' } },
      { key: 'maxChars', kind: 'number', label: 'fieldMaxChars', hint: 'hintMaxChars', step: 50 },
      { key: 'volume', kind: 'number', label: 'fieldVolume', hint: 'hintVolume', step: 5 },
      { key: 'rate', kind: 'number', label: 'fieldRate', hint: 'hintRate', step: 1 },
      { key: 'announceTurnEnd', kind: 'boolean', label: 'fieldAnnounceTurnEnd', hint: 'hintAnnounceTurnEnd' },
      { key: 'announceCommandDone', kind: 'boolean', label: 'fieldAnnounceCommandDone', hint: 'hintAnnounceCommandDone' },
      { key: 'announceGoalChange', kind: 'boolean', label: 'fieldAnnounceGoalChange', hint: 'hintAnnounceGoalChange' },
      { key: 'announceToolErrors', kind: 'boolean', label: 'fieldAnnounceToolErrors', hint: 'hintAnnounceToolErrors' },
      { key: 'announceTodoWrite', kind: 'boolean', label: 'fieldAnnounceTodoWrite', hint: 'hintAnnounceTodoWrite' },
    ]

    // ---------------------------------------------------------------------
    // card chrome — CSS classes injected once (same pattern as official
    // bundles); no imports from official packages (bundle-purity gate).
    // ---------------------------------------------------------------------
    const CSS_ID = 'dsh-speak/client.css'
    const css = `
.dshspk-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dshspk-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshspk-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dshspk-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dshspk-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshspk-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dshspk-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;margin:0}
.dshspk-description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5;margin:0}
.dshspk-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s;display:inline-flex}
.dshspk-chevronOpen{transform:rotate(180deg)}
.dshspk-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dshspk-readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
.dshspk-pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dshspk-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dshspk-field+.dshspk-field{border-top:1px solid var(--dsw-alias-border-l2)}
.dshspk-head{align-items:center;gap:8px;display:flex}
.dshspk-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.dshspk-badges{align-items:center;gap:8px;display:inline-flex}
.dshspk-badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.dshspk-reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}
.dshspk-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dshspk-reset:disabled{cursor:default}
.dshspk-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5}
.dshspk-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshspk-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dshspk-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dshspk-checkRow{align-items:center;gap:8px;display:flex}
.dshspk-switch{appearance:none;position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;transition:background .16s,border-color .16s;flex:none;margin:0;padding:0;box-sizing:border-box}
.dshspk-switch::after{content:"";position:absolute;top:1px;left:1px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-3);transition:transform .16s;box-shadow:0 1px 2px rgba(0,0,0,.2)}
.dshspk-switch[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshspk-switch[data-on="true"]::after{transform:translateX(16px)}
.dshspk-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshspk-switch:disabled{opacity:.4;cursor:default}
.dshspk-switchLabel{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5;min-width:24px}
.dshspk-number{display:flex;align-items:center;gap:0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;height:34px;width:180px;overflow:hidden}
.dshspk-number:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dshspk-number:has(> .dshspk-input:disabled){opacity:.5}
.dshspk-numberInput{border:0;background:0 0;height:100%;font:inherit;color:var(--dsw-alias-label-primary);padding:0 0 0 12px;font-size:13px;line-height:1.5;flex:1;min-width:0;outline:none}
.dshspk-numberInput:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dshspk-stepCol{display:flex;flex-direction:column;border-left:1px solid var(--dsw-alias-border-l2);flex:none}
.dshspk-stepBtn{appearance:none;width:24px;height:17px;display:flex;align-items:center;justify-content:center;background:0 0;border:0;padding:0;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dshspk-stepBtn:first-child{border-bottom:1px solid var(--dsw-alias-border-l2)}
.dshspk-stepBtn:hover:not(:disabled){background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.dshspk-stepBtn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dshspk-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dshspk-failed{min-width:0;color:var(--dsw-alias-label-error);flex:1;margin:0;font-size:12px;line-height:1.5}
.dshspk-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dshspk-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dshspk-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dshspk-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dshspk-discard:disabled,.dshspk-save:disabled{opacity:.4;cursor:default}
.dshspk-discard:focus-visible,.dshspk-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
`
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-speak'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = css
      document.head.appendChild(tag)
    }
    const cx = {
      card: 'dshspk-card',
      cardOpen: 'dshspk-card dshspk-cardOpen',
      header: 'dshspk-header',
      headText: 'dshspk-headText',
      name: 'dshspk-name',
      description: 'dshspk-description',
      chevron: 'dshspk-chevron',
      chevronOpen: 'dshspk-chevron dshspk-chevronOpen',
      body: 'dshspk-body',
      readOnly: 'dshspk-readOnly',
      pending: 'dshspk-pending',
      field: 'dshspk-field',
      head: 'dshspk-head',
      label: 'dshspk-label',
      badges: 'dshspk-badges',
      badge: 'dshspk-badge',
      reset: 'dshspk-reset',
      input: 'dshspk-input',
      hint: 'dshspk-hint',
      checkRow: 'dshspk-checkRow',
      switch: 'dshspk-switch',
      switchLabel: 'dshspk-switchLabel',
      number: 'dshspk-number',
      numberInput: 'dshspk-numberInput',
      stepCol: 'dshspk-stepCol',
      stepBtn: 'dshspk-stepBtn',
      footer: 'dshspk-footer',
      failed: 'dshspk-failed',
      button: 'dshspk-btn',
      discard: 'dshspk-btn dshspk-discard',
      save: 'dshspk-btn dshspk-save',
      saveDisabled: 'dshspk-btn dshspk-save',
    }

    /**
     * One staged edit. `staged` maps field key → { type: 'set', value } or
     * { type: 'clear' }; the form only writes what the user changed.
     */
    function SpeakSettingsCard({ t, scope }) {
      const snapshot = useSyncExternalStore(
        (cb) => scope.subscribe(cb),
        () => scope.getSnapshot(),
        () => scope.getSnapshot(),
      )
      const [open, setOpen] = useState(false)
      const [staged, setStaged] = useState(() => ({}))
      const [saving, setSaving] = useState(false)
      const [failed, setFailed] = useState(false)

      if (snapshot.status !== 'ready') {
        return h('li', { className: cx.card },
          h('button', { type: 'button', className: cx.header, onClick: () => setOpen(!open) },
            h('span', { className: cx.headText },
              h('h3', { className: cx.name }, t('cardTitle')),
              h('p', { className: cx.description }, t('cardDescription')),
            ),
            h('span', { className: open ? cx.chevronOpen : cx.chevron },
              h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
                h('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
              ),
            ),
          ),
        )
      }
      const value = snapshot.value || {}
      const user = snapshot.user
      const writable = snapshot.writable
      const dirty = Object.keys(staged).length > 0

      function effective(field) {
        if (staged[field]) return staged[field].value
        return value[field]
      }
      function overridden(field) {
        return user !== undefined && user !== null && Object.prototype.hasOwnProperty.call(user, field)
      }
      function stage(field, next) {
        setFailed(false)
        setStaged((prev) => {
          const copy = { ...prev }
          if (next === undefined) delete copy[field]
          else copy[field] = { value: next }
          return copy
        })
      }
      function stageClear(field) {
        setFailed(false)
        setStaged((prev) => ({ ...prev, [field]: { value: undefined, clear: true } }))
      }
      function fieldCurrent(field) {
        const s = staged[field]
        if (s) return s.clear ? '' : String(s.value ?? '')
        return String(value[field] ?? '')
      }
      function fieldBool(field) {
        const s = staged[field]
        if (s) return s.clear ? false : !!s.value
        return !!value[field]
      }

      async function save() {
        if (saving) return
        setSaving(true)
        setFailed(false)
        try {
          for (const [field, edit] of Object.entries(staged)) {
            if (edit.clear || edit.value === undefined || edit.value === '') {
              await scope.unset(field)
            } else {
              await scope.set(field, edit.value)
            }
          }
          setStaged({})
        } catch (e) {
          setFailed(true)
        } finally {
          setSaving(false)
        }
      }
      function discard() {
        setStaged({})
        setFailed(false)
      }

      const fieldNodes = FIELDS
        .filter((f) => {
          // showWhen: only render the field when the referenced field matches
          if (!f.showWhen) return true
          return effective(f.showWhen.key) === f.showWhen.value
        })
        .map((f) => {
        // dependency lock: a switch that needs another switch on first
        const locked = f.dependsOn ? !fieldBool(f.dependsOn) : false
        let control
        if (f.kind === 'boolean') {
          const on = fieldBool(f.key)
          const disabled = !writable || locked
          const effectiveOn = locked ? false : on
          control = h('label', { className: cx.checkRow, key: 'ctl' },
            h('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': effectiveOn ? 'true' : 'false',
              'data-on': effectiveOn ? 'true' : 'false',
              className: cx.switch,
              disabled,
              title: locked ? t('hintDependsOnApprovals') : undefined,
              onClick: (e) => {
                e.preventDefault()
                if (!locked) stage(f.key, !on)
              },
            }),
            h('span', { className: cx.switchLabel }, t(effectiveOn ? 'booleanTrue' : 'booleanFalse')),
          )
        } else if (f.kind === 'select') {
          control = h('select', {
            className: cx.input,
            value: String(effective(f.key) ?? f.options[0]),
            disabled: !writable,
            onChange: (e) => stage(f.key, e.target.value),
          }, f.options.map((opt) => h('option', { key: opt, value: opt }, t(opt === 'message' ? 'selectMessage' : 'selectHeading'))))
        } else if (f.kind === 'number') {
          const step = f.step || 1
          const current = fieldCurrent(f.key)
          const numNow = current === '' ? null : Number(current)
          const bump = (delta) => {
            const base = (numNow === null || !Number.isFinite(numNow)) ? 0 : numNow
            const next = base + delta
            if (next < 0) { stageClear(f.key); return }
            stage(f.key, next)
          }
          control = h('div', { className: cx.number, key: 'ctl' },
            h('input', {
              type: 'text',
              inputMode: 'numeric',
              className: cx.numberInput,
              value: current,
              placeholder: '',
              disabled: !writable,
              'aria-label': t(f.label),
              onChange: (e) => {
                const raw = e.target.value.trim()
                if (raw === '') { stageClear(f.key); return }
                const num = Number(raw)
                if (Number.isFinite(num) && num >= 0) stage(f.key, num)
              },
            }),
            h('span', { className: cx.stepCol },
              h('button', {
                type: 'button',
                className: cx.stepBtn,
                disabled: !writable,
                'aria-label': `${t(f.label)} +${step}`,
                onClick: () => bump(step),
              }, h('svg', { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
                h('path', { d: 'M8 3v10M3 8h10', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
              )),
              h('button', {
                type: 'button',
                className: cx.stepBtn,
                disabled: !writable,
                'aria-label': `${t(f.label)} -${step}`,
                onClick: () => bump(-step),
              }, h('svg', { width: 10, height: 10, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
                h('path', { d: 'M3 8h10', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
              )),
            ),
          )
        } else {
          control = h('input', {
            type: 'text',
            className: cx.input,
            value: fieldCurrent(f.key),
            placeholder: '',
            disabled: !writable,
            onChange: (e) => {
              const raw = e.target.value
              if (raw === '') { stageClear(f.key); return }
              stage(f.key, raw)
            },
          })
        }
        return h('div', { className: cx.field, key: f.key },
          h('div', { className: cx.head },
            h('label', { className: cx.label, htmlFor: `dsh-speak-${f.key}` }, t(f.label)),
            h('span', { className: cx.badges },
              overridden(f.key) ? h('span', { className: cx.badge }, t('overridden')) : null,
              overridden(f.key) && writable ? h('button', {
                type: 'button',
                className: cx.reset,
                disabled: !writable,
                onClick: () => stageClear(f.key),
              }, t('reset')) : null,
            ),
          ),
          control,
          h('p', { className: cx.hint }, locked ? t('hintDependsOnApprovals') : t(f.hint)),
        )
      })

      return h('li', { className: open ? cx.cardOpen : cx.card },        h('button', {
          type: 'button',
          className: cx.header,
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': `${t(open ? 'collapse' : 'expand')}: ${t('cardTitle')}`,
          onClick: () => setOpen(!open),
        },
          h('span', { className: cx.headText },
            h('h3', { className: cx.name }, t('cardTitle')),
            h('p', { className: cx.description }, t('cardDescription')),
          ),
          dirty ? h('span', { className: cx.pending }, t('unsaved')) : null,
          h('span', { className: open ? cx.chevronOpen : cx.chevron },
            h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
              h('path', { d: 'M4 6l4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
            ),
          ),
        ),
        open ? h('div', { className: cx.body },
          !writable ? h('p', { className: cx.readOnly }, t('readOnly')) : null,
          fieldNodes,
          h('div', { className: cx.footer },
            failed ? h('p', { className: cx.failed }, t('saveFailed')) : null,
            h('button', {
              type: 'button',
              className: cx.discard,
              disabled: !dirty || saving,
              onClick: discard,
            }, t('discard')),
            h('button', {
              type: 'button',
              className: cx.save,
              disabled: !dirty || saving,
              onClick: save,
            }, t(saving ? 'saving' : 'save')),
          ),
        ) : null,
      )
    }

    // ---------------------------------------------------------------------
    // plugin entry
    // ---------------------------------------------------------------------
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-speak: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.inject(['settingsScope'], (scoped) => {
        const scope = scoped.settingsScope.bind({ namespace: NS })
        scoped.slots.inject('settings.plugin.item', () => scoped.slots.register({
          name: 'settings.plugin.item',
          key: NS,
          locale: NS,
          inject: () => ({ t }),
        }, () => h(SpeakSettingsCard, { t, scope })))
      })
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
