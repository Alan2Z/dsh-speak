// test-speech-hook.js — local smoke test for the new event announcements.
// Mocks a minimal Cordis ctx + session/event emitter, loads speech-hook.js,
// and asserts the announced texts for each new event type. Settings namespace
// registration is expected to fail gracefully here (no dsh-settings in the
// local resolution path) — that path is verified in the real DSH environment.
'use strict'
const assert = require('assert')
const path = require('path')
const fs = require('fs')
const cp = require('child_process')

// Capture spoken text via fs.writeFileSync (property access — mockable).
// speak() writes the announcement to a temp file before spawning the engine.
const announced = []
const origWrite = fs.writeFileSync
fs.writeFileSync = (file, text, enc) => {
  if (String(file).includes('dsh-speech-') && String(file).endsWith('.txt')) {
    announced.push(String(text))
  }
  return origWrite.call(fs, file, text, enc)
}
// Never spawn a real powershell; speech-hook.js destructures spawn at load
// time, so also stub process.platform to a no-op path is unnecessary — the
// destructured reference still calls the real spawn. Instead, force the
// engine script to a nonexistent path so spawn fails harmlessly.
const realSpawn = cp.spawn
cp.spawn = () => ({ on() {} })

const listeners = {}
const ctx = {
  on(name, cb) { listeners[name] = cb },
  inject() {},
  effect() {},
}

const hook = require(path.join(__dirname, '..', 'adapters', 'dsh', 'speech-hook.js'))
hook.apply(ctx, {
  announceTurnEnd: true,
  announceCommandDone: true,
  announceGoalChange: true,
  announceToolErrors: true,
  announceTodoWrite: true,
})

function fire(type, data) {
  listeners['session/event'](null, { type, data })
}

// turn/end
fire('turn/end', { turn: 3, reason: { kind: 'completed' } })
// command/done success + error
fire('command/done', { kind: 'success' })
fire('command/done', { kind: 'error' })
// goal/change create + complete
fire('goal/change', { operation: 'create', goal: { objective: '重构语音播报模块，让长任务完成时开口告诉你' } })
fire('goal/change', { operation: 'complete', goal: { objective: '重构语音播报模块' } })
// tool/result with error + without
fire('tool/result', { error: { message: 'sandbox denied: file access', code: 'EBLOCKED' } })
fire('tool/result', { message: { content: [] } })
// todo/write
fire('todo/write', { todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }] })

// ---- master switch: disabled → nothing announces ----
const countBefore = announced.length
const hook2 = require(path.join(__dirname, '..', 'adapters', 'dsh', 'speech-hook.js'))
hook2.apply(ctx, {
  enabled: false, // 总开关关闭
  announceTurnEnd: true,
  announceCommandDone: true,
  announceGoalChange: true,
  announceToolErrors: true,
  announceTodoWrite: true,
})
fire('turn/end', { turn: 7, reason: { kind: 'completed' } })
fire('command/done', { kind: 'success' })
fire('goal/change', { operation: 'create', goal: { objective: '总开关关闭时不应播报' } })
fire('tool/result', { error: { message: 'should not speak', code: 'E2' } })
fire('todo/write', { todos: [{ status: 'completed' }] })
fire('assistant/message', { surfaceOp: 'append', data: { message: { content: [{ type: 'text', text: '最终回复也不应播报' }] } } })

console.log('--- master switch off: announced count delta =', announced.length - countBefore, '---')
assert.strictEqual(announced.length, countBefore, '总开关关闭时任何事件都不应播报')

console.log('--- announced texts ---')
announced.forEach((t, i) => console.log(`[${i}] ${t}`))
console.log('--- assertions ---')
assert.strictEqual(announced[0], '第 3 轮对话完成', 'turn/end completed')
assert.strictEqual(announced[1], '命令执行完成', 'command/done success')
assert.strictEqual(announced[2], '命令执行失败', 'command/done error')
assert.ok(announced[3].startsWith('已创建目标：重构语音播报模块'), `goal create: ${announced[3]}`)
assert.strictEqual(announced[4], '目标已完成：重构语音播报模块', 'goal complete')
assert.ok(announced[5].startsWith('工具调用出错：sandbox denied'), `tool error: ${announced[5]}`)
assert.strictEqual(announced[6], '待办已更新：1/3 完成', 'todo write')
console.log('ALL PASS ✓')
