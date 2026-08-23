# CUSTOMIZATION.md — customizing dsh-speak

(中文版：docs/CUSTOMIZATION.zh-CN.md)

dsh-speak is deliberately small, but it exposes three levels of customization:
**configuration** (no code), **engine override** (copy & edit), and **extension**
(new backends / adapters). Everything below survives `npm update`.

---

## 1. Configuration (recommended)

**Either way works, and they stay in sync** (both write the same settings
document):

1. **Web UI (1.6.0, recommended)**: Settings → Plugins → Plugin configuration →
   the Voice announcements card. Every option is editable and saved there —
   visible in `dsh --dump-config`, per-profile, and never overwritten by npm.
2. **Profile patch `config` block** (equivalent):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: speech-hook
      name: 'dsh-speak'
      config:
        throttleMs: 1500        # merge delay before announcing (ms)
        engine: ''              # engine path override; '' = auto-resolve
        announceApprovals: true # speak approval requests
        announceQuestions: true # speak ask_user_question content
        stripApprovalPrefix: true  # strip "escalate sandbox to ...: " prefix
        longTextMode: message   # message | heading (speak largest md heading)
        maxChars: 300           # engine per-utterance ceiling
        volume: 50              # Windows only
        rate: 0                 # 0 = engine default (Windows SAPI scale / macOS wpm)
        # —— optional event announcements (1.6.0, all off by default) ——
        announceTurnEnd: false     # turn/end — "第 N 轮对话完成"
        announceCommandDone: false # command/done — command finished/failed
        announceGoalChange: false  # goal/change — goal created/updated/completed
        announceToolErrors: false  # tool/result with error — error summary
        announceTodoWrite: false   # todo/write — todo list updated
```

### Option reference

| option | default | effect |
| ------ | ------- | ------ |
| `throttleMs` | `1500` | how long a reply's text waits before being announced (merges multi-step messages) |
| `engine` | `''` | explicit engine script path; `''` auto-resolves: `<package>/engine/<platform>` → `~/.dsh/hooks/<platform>` |
| `announceApprovals` | `true` | announce `approval/asked` events (reason, or the fixed prompt) |
| `announceQuestions` | `true` | announce `ask_user_question` calls as "question（单选/多选），选项：…" |
| `stripApprovalPrefix` | `true` | strip the fixed English template prefix (`escalate sandbox to danger-full-access: `) from approval reasons, keeping the human explanation |
| `longTextMode` | `message` | `message` = fixed prompt for over-long text; `heading` = speak the largest markdown heading instead (see below) |
| `maxChars` | `300` | engine per-utterance ceiling (SAPI/NVSAPIAdapter fails silently beyond ~375-470) |
| `volume` | `50` | Windows only (0-100); macOS volume follows the system |
| `rate` | `0` | `0` = engine default (Windows SAPI scale, e.g. 1; macOS words-per-minute, e.g. 175) |
| `announceTurnEnd` | `false` | announce "第 N 轮对话完成/中断/异常结束" on turn end (`turn/end`) |
| `announceCommandDone` | `false` | announce when a command finishes or fails (`command/done`) |
| `announceGoalChange` | `false` | announce goal created/updated/completed/paused/resumed (`goal/change`, objective head) |
| `announceToolErrors` | `false` | announce an error summary when a tool call returns an error (`tool/result` with `error`) |
| `announceTodoWrite` | `false` | announce "待办已更新：n/m 完成" when the agent updates its todos (`todo/write`) |

> Resolution order: schema default → patch `config` → UI user settings. Fields
> edited in the UI carry an "Overridden" badge and can be reset to default;
> fields written in YAML show up in the UI too.

### Long-text modes

When cleaned text exceeds `maxChars`:

- **`message`** (default): speak `LongTextMessage` (`本次播报内容较长，请自行阅读。`, overridable via engine param `-LongTextMessage` / `-l`).
- **`heading`**: pick the *largest* markdown heading in the raw text — fewest `#` wins, tie → first; if there is no heading line, the first non-empty line is used. The chosen candidate is still cleaned and subject to the `maxChars` ceiling, falling back to the message if it is itself too long.

---

## 2. Engine override (copy & edit)

To change what is actually spoken (voice selection, cleaning rules, defaults),
copy the engine out of the package and point the plugin at your copy:

```powershell
# Windows
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-speak\engine\speak.ps1" "$env:USERPROFILE\.dsh\hooks\my-speak.ps1"
# macOS
cp ~/.dsh/profiles/web/node_modules/dsh-speak/engine/speak.sh ~/.dsh/hooks/my-speak.sh
```

Then set the engine path in config:

```yaml
config:
  engine: 'C:/Users/<you>/.dsh/hooks/my-speak.ps1'   # or ~/.dsh/hooks/my-speak.sh on macOS
```

`npm update` never touches your copy.

---

## 3. Extension

- **New engine backend**: the engine is the single seam. A new backend
  (`speak-edge.ps1` for edge-tts, `speak-piper.ps1` for a local model, ...) keeps
  the same parameter contract and cleaning pipeline — adapters never change.
  See [DESIGN.md §7](DESIGN.md#7-extending).
- **New harness adapter**: capture the final reply text → call the engine. The
  DSH (event stream), Claude Code (Stop hook), and agent-called
  (`speech-summary.ps1`) patterns are the three references.
- **Your own published variant**: fork this repo, adjust, publish your own npm
  package — the `dsh.bundle` manifest already makes it `dsh plugin add`-installable.
