# dsh-speak 🔊 — Voice announcements for AI coding harnesses

**English** · [中文](README.zh-CN.md)

![鲸鱼娘大喇叭](鲸鱼娘大喇叭.png)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[![npm version](https://img.shields.io/npm/v/dsh-speak)](https://www.npmjs.com/package/dsh-speak)

Let your agent **tell you** when a long task is done — no more staring at the screen.

dsh-speak reads the final assistant reply aloud through system speech synthesis —
on Windows using natural voices (Windows 11 built-in, or
[NaturalVoiceSAPIAdapter] on Windows 10) with graceful fallback to stock voices;
on macOS using the built-in `say` (can follow a Siri natural voice). It was built
for [DeepSeek Harness](https://github.com/deepseek-ai/dsh)
and is structured so any harness can plug in.

## Features

- **Automatic**: DSH web plugin watches the session event stream and announces the
  final reply (skips reasoning/tool-call narration, merges multi-step messages).
- **Gets your attention**: announces approval requests (hears "需要你的审批" when
  the agent is waiting on you) and questions the agent asks via `ask_user_question`.
- **Final-reply replay** (1.7.0): every final reply (turn tail) has a 🔊 button
  in its action bar — click to replay that message, click again to stop, click
  another to switch. Speech execution stays fully owned by the DSH host (keeps
  speaking even with the browser closed).
- **Host speech queue** (1.7.0): only one native speech process runs at a time;
  queued items continue automatically. A WebSocket syncs the live state (which
  message is speaking, queue length) to the UI.
- **Optional event announcements** (1.6.0): turn end, command done, goal changes,
  tool errors, and todo updates can each be announced, toggled independently
  (off by default).
- **Visual configuration** (1.7.0): a dedicated Settings → dsh-speak settings
  page — every option (master switch, automatic speech, Markdown cleaning, code
  blocks, event toggles, fixed prompt, …) is editable from the Web UI, no
  hand-edited YAML.
- **Master switch** (1.6.0): silence everything with one toggle.
- **Bundle auto-registration** (1.3.0): declare the package in `dsh.profile.bundles`
  and the plugin registers itself via the bundled `cordis.patch.yml` — no manual
  patch entry needed.
- **Best-effort**: never throws, never blocks the harness, never breaks a session.
- **Natural voices**: Windows prefers natural voices — Windows 11 built-in packs,
  or voices registered via NaturalVoiceSAPIAdapter on Windows 10 (e.g. Xiaoxiao);
  macOS uses the system reading voice (Siri natural voices on recent macOS). Both
  fall back to any installed voice.
- **Robust text cleaning**: strips markdown/URLs/emoji that make speech synthesis
  fail silently, and guards the adapter's per-utterance character ceiling.
- **Portable engine**: any process can speak with one line:
  Windows `powershell -File speak.ps1 -Text "你好"` / macOS `./speak.sh -t "你好"`.

## How it works

```
harness event (DSH session event / Claude Code Stop hook / anything)
      │
      ▼  adapters/…  (harness-specific trigger: filter, throttle, cancel)
      ▼  engine/speak.ps1 / speak.sh  (harness-agnostic: clean text → SAPI5 / say)
      ▼  🔊 you hear the final reply
```

The adapter turns harness-specific events into engine calls; the engine cleans the
text and speaks it, fully decoupled from any harness. Full design:
[docs/DESIGN.md](docs/DESIGN.md).

## Prerequisites

Windows:

- Windows 10 or 11, PowerShell (any recent version).
- Natural voices:
  - **Windows 11 (21H2–23H2)**: natural voice packs are built into the system —
    no extra installation. Enable/switch them in *Settings → Accessibility →
    Narrator* or *Settings → Time & Language → Speech*.
  - **Windows 11 24H2/25H2**: natural voices moved to MSIX app packages, which
    `System.Speech` may not enumerate (falls back to a robotic stock voice). As
    on Windows 10, install
    [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)
    to bridge them.
  - **Windows 10**: install
    [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)
    and use its VoiceDownloader to download the natural voice pack(s) you want
    (Chinese or any other language).
- Without natural voices, the engine falls back to a stock voice (e.g. Huihui).

macOS:

- macOS (Apple Silicon or Intel), built-in `say` command — **no extra software**.
- Chinese voices: see the [macOS](#macos) section (incl. the Siri natural-voice
  picker and its pitfalls).

## Install & quick start

### DSH — Option A: npm plugin (recommended)

```powershell
# 1. install the plugin into your web profile (adds dsh-speak to
#    ~/.dsh/profiles/web/package.json dependencies)
dsh plugin --profile web add dsh-speak

# 2. register it in ~/.dsh/profiles/web/cordis.patch.yml
#    (for npm packages the bare package name is used — no file:/// URL needed):
#    - insert:
#        - id: speech-hook
#          name: 'dsh-speak'

# 3. restart the DSH web app — replies are now announced automatically
```

> **No pnpm?** `dsh plugin` forwards to pnpm, which is not installed on every
> machine. The exact same install can be done with npm directly:
>
> ```powershell
> npm install --prefix "$env:USERPROFILE\.dsh\profiles\web" dsh-speak
> ```
>
> On macOS (bash):
>
> ```bash
> npm install --prefix "$HOME/.dsh/profiles/web" dsh-speak
> ```

The engine ships inside the package (`node_modules/dsh-speak/engine/`), so no extra
copying is needed.

> **Let your agent do it?** Paste this repo URL
> (`https://github.com/Alan2Z/dsh-speak`) into your DSH session and ask it to
> install the plugin — your agent follows this very README. Approving the
> out-of-workspace writes (`~/.dsh`) is all that's needed.

### DSH — Option B: file install (no npm needed)

```powershell
# 1. clone
git clone https://github.com/Alan2Z/dsh-speak.git
cd dsh-speak

# 2. one-command install: copies engine + plugin, registers in cordis.patch.yml
powershell.exe -NoProfile -ExecutionPolicy Bypass -File adapters\dsh\install.ps1

# 3. verify the engine speaks
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\hooks\speak.ps1" -Text "你好，语音播报已就绪。"

# 4. restart the DSH web app — replies are now announced automatically
```

What the file installer did:

| file | destination |
| ---- | ----------- |
| `engine/*.ps1` | `%USERPROFILE%\.dsh\hooks\` |
| `adapters/dsh/speech-hook.js` | `%USERPROFILE%\.dsh\profiles\web\plugins\` |
| registration entry | appended to `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` (backed up first) |

### macOS

The same adapter runs natively on macOS — the plugin auto-detects the platform and
calls `engine/speak.sh` (the built-in `say` command) instead of `speak.ps1`.
**Since 1.2.0 the macOS engine ships in the npm package** — no extra software.

```bash
# 1. install into your web profile (no pnpm needed — only `dsh plugin` requires it)
npm install --prefix "$HOME/.dsh/profiles/web" dsh-speak

# 2. register in ~/.dsh/profiles/web/cordis.patch.yml (bare package name — no file:/// URL):
#    - insert:
#        - id: speech-hook
#          name: 'dsh-speak'

# 3. no restart needed — the patch watcher hot-reloads; replies are announced
#    after the throttle (~1.5 s); tool-calling replies are announced at turn end
```

> With pnpm installed, `dsh plugin --profile web add dsh-speak` works identically.

#### Voices (important — two pitfalls)

- By default the engine follows the **system reading voice** (*Settings →
  Accessibility → Spoken Content → System Voice*). On **macOS 26** that picker has
  an **ⓘ circle icon** next to it — click it for the full voice list; the plain
  dropdown does **not** contain the Siri natural voices. Pick e.g. "普通话 Siri
  声音1（男声）" there.
- **Siri voice** (*Settings → Siri → Voice*) and the system reading voice are
  **two independent settings**; Siri voices are not exposed to `say -v '?'` and
  cannot be selected by name — they only work as the system default.
- ⚠️ **Pitfall 1 (reproduced)**: opening the "Spoken Content / Siri Voice" settings
  pane — **even without changing anything** — drifts/resets the system voice to the
  classic "婷婷 (Tingting)". If the voice suddenly changes, re-pick it via the ⓘ
  entry.
- ⚠️ **Pitfall 2**: the log lives at `$TMPDIR/dsh-speech-hook.log`
  (`os.tmpdir()` — **not** `/tmp`).
- Use `-v Eddy|Flo|Tingting` to force a specific voice (`say -v '?'` lists them).
- `say` has no volume flag — volume follows the system output volume.

#### Test the engine alone (no DSH needed)

```bash
curl -sfL -o ~/speak.sh "https://cdn.jsdelivr.net/gh/Alan2Z/dsh-speak@main/engine/speak.sh"
chmod +x ~/speak.sh
~/speak.sh -t "你好，Mac 版语音播报测试"
~/speak.sh -t "测试" -v Eddy -r 200              # explicit voice + rate
```

### Claude Code

Register the Stop hook in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\path\\to\\dsh-speak\\adapters\\claude-code\\stop-hook.ps1"
          }
        ]
      }
    ]
  }
}
```

### Any other harness

Call the engine directly from your agent / wrapper / script:

```powershell
# announce a one-liner
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speak.ps1 -Text "构建完成"

# announce a long summary (blocking, returns when done)
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speech-summary.ps1 -Text "…"

# ask for user attention (blocking, for prompts/approvals)
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speech-prompt.ps1 -Text "请做出选择"
```

## Configuration

### Engine parameters

See [docs/DESIGN.md §5 configuration reference](docs/DESIGN.md#5-configuration-reference):

```powershell
speak.ps1 -Text "…" -Volume 50 -Rate 1 -MaxChars 300 -LongTextMessage "本次播报内容较长，请自行阅读。"
```

### DSH plugin config

**Either way works, and they stay in sync** (both write the same settings
document):

1. **Web UI (1.7.0, recommended)**: a dedicated Settings → dsh-speak settings
   page. Every option is editable and saved there (visible in `dsh --dump-config`,
   per-profile, survives npm updates).
2. **Profile patch `config` block** (equivalent):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: speech-hook
      name: 'dsh-speak'
      config:
        enabled: true           # master switch: false silences everything
        automaticSpeech: true   # auto-speak final replies
        queueAllMessages: false # true = enqueue every assistant message as it arrives
        replayFullRead: false   # true = manual replay skips the long-text truncation, reads everything
        cleanMarkdownFormatting: true # convert Markdown to natural speech
        readInlineCode: true    # read inline code without backticks
        codeBlocks: smart       # all | smart | replace (fenced code blocks)
        codeBlockMaxChars: 300  # smart-mode code block character limit
        codeBlockReplacementText: 'You can see the code in our history.' # replace-mode text
        throttleMs: 1500        # merge delay before announcing (ms)
        engine: ''              # engine path override; '' = auto-resolve
        announceApprovals: true # speak approval requests
        announceQuestions: true # speak ask_user_question content
        stripApprovalPrefix: true  # strip "escalate sandbox to ...: " prefix
        questionGapMs: 2000      # pause between multiple question announcements (ms)
        longTextMode: message   # message | heading (speak largest md heading)
        longTextMessage: '本次播报内容较长，请自行阅读。' # fixed prompt for message mode
        maxChars: 300           # per-utterance ceiling (macOS default 0 = unlimited)
        volume: 50              # Windows only
        rate: 0                 # 0 = engine default (Windows SAPI scale / macOS wpm)
        # —— optional event announcements (1.6.0, all off by default) ——
        announceTurnEnd: false     # turn/end — "第 N 轮对话完成"
        announceCommandDone: false # command/done — command finished/failed
        announceGoalChange: false  # goal/change — goal created/updated/completed
        announceToolErrors: false  # tool/result error — announce (english dropped)
        announceTodoWrite: false   # todo/write — todo list updated
```

> Resolution order: schema default → patch `config` → UI user settings. Fields
> written in YAML show up in the UI too. Platform note: `maxChars` defaults to
> 0 on macOS (`say` has no ceiling) and 300 on Windows (SAPI safe limit).

#### Option reference

| option | default | effect |
| ------ | ------- | ------ |
| `enabled` | `true` | **master switch**: when off, nothing is ever announced (final reply / approvals / questions / optional events / replay) |
| `automaticSpeech` | `true` | auto-speak final replies; manual replay always remains available |
| `queueAllMessages` | `false` | `true` enqueues every assistant message as it arrives (intermediate messages spoken too, FIFO); default only speaks the throttled final reply |
| `replayFullRead` | `false` | `true` makes manual replay skip the long-text heading truncation (`longTextMode: heading`) and read everything in chunks |
| `cleanMarkdownFormatting` | `true` | converts Markdown into natural speech text (link labels kept, URLs/heading/emphasis cleaned) |
| `readInlineCode` | `true` | read inline code without backtick markers |
| `codeBlocks` | `smart` | fenced code blocks: `all` read / `smart` (read when ≤ `codeBlockMaxChars`) / `replace` with the replacement text |
| `codeBlockMaxChars` | `300` | code block character limit for `smart` mode |
| `codeBlockReplacementText` | `You can see the code in our history.` | replacement spoken in `replace` mode (or over-limit `smart`) |
| `throttleMs` | `1500` | how long a reply's text waits before being announced (merges multi-step messages) |
| `engine` | `''` | explicit engine script path; `''` auto-resolves: `<package>/engine/<platform>` → `~/.dsh/hooks/<platform>` |
| `announceApprovals` | `true` | announce `approval/asked` events (reason, or the fixed prompt) |
| `announceQuestions` | `true` | announce `ask_user_question`: each question spoken separately with a "问题N" prefix (when several) and "选项N" prefixes matching the UI numbering; a `questionGapMs` pause between questions |
| `questionGapMs` | `2000` | pause between multiple question announcements (ms); 0 = no pause |
| `stripApprovalPrefix` | `true` | strip the fixed English template prefix (`escalate sandbox to danger-full-access: `) from approval reasons, keeping the human explanation |
| `longTextMode` | `message` | `message` = fixed prompt for over-long text; `heading` = speak the largest markdown heading instead (see below) |
| `longTextMessage` | `本次播报内容较长，请自行阅读。` | the fixed prompt spoken for over-long text in `message` mode (editable in the UI) |
| `maxChars` | platform | per-utterance ceiling. **macOS default 0 (`say` has no ceiling); Windows default 300** (SAPI fails silently beyond ~375-470) |
| `volume` | `50` | Windows only (0-100); macOS volume follows the system |
| `rate` | `0` | speech rate: Windows SAPI scale (-10 to 10, 0 = normal; try 1-3 for faster); macOS words-per-minute (default 175, 200 is a bit faster) |
| `announceTurnEnd` | `false` | announce "第 N 轮对话完成/中断/异常结束" on turn end (`turn/end`) |
| `announceCommandDone` | `false` | announce when a command finishes or fails (`command/done`) |
| `announceGoalChange` | `false` | announce goal created/updated/completed/paused/resumed (`goal/change`, objective head) |
| `announceToolErrors` | `false` | announce "工具调用出错" when a tool call returns an error (`tool/result` with `error` or an `isError` content block; English details / technical codes dropped, Chinese details kept) |
| `announceTodoWrite` | `false` | announce "待办已更新：n/m 完成" when the agent updates its todos (`todo/write`) |

#### Long-text modes

When cleaned text exceeds `maxChars`:

- **`message`** (default): speak `longTextMessage` (`本次播报内容较长，请自行阅读。`,
  editable in the UI or YAML).
- **`heading`**: pick the *largest* markdown heading in the raw text — fewest `#`
  wins, tie → first; if there is no heading line, the first non-empty line is used.
  The chosen candidate is still cleaned and subject to the `maxChars` ceiling,
  falling back to the message if it is itself too long.

Full architecture and design rationale: [docs/DESIGN.md](docs/DESIGN.md).

## Customizing (survives npm updates)

You can tune behavior without forking, and your changes **survive `npm update`**:

1. **Copy the engine out and edit it** (recommended — this is where defaults live: volume,
   rate, `MaxChars`, `LongTextMessage`, voice logic):

   ```powershell
   # Windows
   Copy-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-speak\engine\speak.ps1" "$env:USERPROFILE\.dsh\hooks\my-speak.ps1"
   # macOS
   cp ~/.dsh/profiles/web/node_modules/dsh-speak/engine/speak.sh ~/.dsh/hooks/my-speak.sh
   ```

   Then point the plugin at your copy in the `config` block:

   ```yaml
   - insert:
       - id: speech-hook
         name: 'dsh-speak'
         config:
           engine: 'C:/Users/<you>/.dsh/hooks/my-speak.ps1'   # or ~/.dsh/hooks/my-speak.sh on macOS
   ```

   The plugin resolves the engine as `config.engine` → package engine → `~/.dsh/hooks/`,
   so your copy wins. `npm update` only touches the package — your engine stays.

2. **Edit the file inside `node_modules`** — works, but the next `npm update` overwrites it.

3. **Fork the repo** — full control, publish your own package if you want.

## Troubleshooting

| symptom | cause | fix |
| ------- | ----- | --- |
| No sound at all, no error | no natural voice enabled/installed | Win11: enable a natural voice in *Settings → Narrator / Speech*; Win10: install NaturalVoiceSAPIAdapter + a voice pack. Test `speak.ps1` directly |
| Long replies never spoken | adapter per-`Speak` character ceiling | already guarded at 300 chars — lower `-MaxChars` if needed |
| Emoji-heavy text silent | SAPI fails silently on emoji | already stripped by the engine |
| Plugin not loading | raw Windows path as plugin name | use the `file:///C:/…` URL form (installer does this) |
| macOS: voice suddenly became "婷婷" | opening the "Spoken Content / Siri Voice" pane drifted the system voice | re-pick via Settings → Accessibility → Spoken Content → System Voice → ⓘ entry |
| macOS: no log at `/tmp` | `os.tmpdir()` is `/var/folders/.../T`, not `/tmp` | log is at `$TMPDIR/dsh-speech-hook.log` |

Plugin diagnostics: Windows `%TEMP%\dsh-speech-hook.log`; macOS `$TMPDIR/dsh-speech-hook.log`

## Repository layout

```
engine/                  harness-agnostic speech engine (PowerShell + SAPI5 / bash + say)
  speak.ps1 / speak.sh   clean + speak (the only seam any adapter needs)
  speech-prompt.ps1      blocking short announcement
  speech-summary.ps1     blocking reply-summary announcement
adapters/
  dsh/                   DSH web plugin + one-command installer
    speech-hook.js       session-event trigger (throttle/cancel + optional events + FIFO speech queue + WebSocket + settings registration)
    install.ps1          copies + registers + backs up
  claude-code/
    stop-hook.ps1        Claude Code Stop hook trigger
client/
  client.js              DSH browser bundle: turn-tail Speak/Stop button + Settings → dsh-speak settings page
docs/
  DESIGN.md              full design rationale, pitfalls, extension guide
```

## Writing a new adapter

Three reference patterns exist: **event-stream** (DSH), **stop-hook** (Claude Code),
**agent-called** (`speech-summary.ps1` from a shell). In every case the adapter only
needs to: capture the *final reply text* → invoke the engine. See
[docs/DESIGN.md §7](docs/DESIGN.md#7-extending).

## License

MIT — see [LICENSE](LICENSE).

[NaturalVoiceSAPIAdapter]: https://github.com/gexgd0419/NaturalVoiceSAPIAdapter
