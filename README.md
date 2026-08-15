# dsh-speak 🔊 — Voice announcements for AI coding harnesses

**English** · [中文](README.zh-CN.md)

![鲸鱼娘大喇叭](鲸鱼娘大喇叭.png)

Let your agent **tell you** when a long task is done — no more staring at the screen.

dsh-speak reads the final assistant reply aloud through Windows speech synthesis,
using natural voices (Windows 11 built-in, or [NaturalVoiceSAPIAdapter] on
Windows 10) with graceful fallback to stock voices. It was built for
[DeepSeek Harness](https://github.com/deepseek-ai/dsh)
and is structured so any harness can plug in.

> **Project status**: this project exists only to provide an **already-verified
> solution** for users who want their harness to speak. Barring unexpected
> circumstances, it will not be updated further.

## TL;DR — install for DSH

1. Install the package into your web profile (pick one):

   ```powershell
   dsh plugin --profile web add dsh-speak
   # or, without pnpm:
   npm install --prefix "$env:USERPROFILE\.dsh\profiles\web" dsh-speak
   ```

2. Append to `~/.dsh/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: speech-hook
         name: 'dsh-speak'
   ```

3. Restart the DSH web app — replies are now announced aloud.

> **Let your agent do it?** Paste this repo URL
> (`https://github.com/Alan2Z/dsh-speak`) into your DSH session and ask it to
> install the plugin — your agent follows this very README. Approving the
> out-of-workspace writes (`~/.dsh`) is all that's needed.

```
harness event (DSH session event / Claude Code Stop hook / anything)
      │
      ▼  adapters/…  (harness-specific trigger: filter, throttle, cancel)
      ▼  engine/speak.ps1  (harness-agnostic: clean text → Windows SAPI5)
      ▼  🔊 you hear the final reply
```

## Features

- **Automatic**: DSH web plugin watches the session event stream and announces the
  final reply (skips reasoning/tool-call narration, merges multi-step messages).
- **Best-effort**: never throws, never blocks the harness, never breaks a session.
- **Natural voices**: prefers natural voices — Windows 11 built-in packs, or
  voices registered via NaturalVoiceSAPIAdapter on Windows 10 (e.g. Xiaoxiao) —
  and falls back to any installed voice.
- **Robust text cleaning**: strips markdown/URLs/emoji that make SAPI `Speak()`
  silently fail, and guards the adapter's per-utterance character ceiling.
- **Portable engine**: any process can speak with one line:
  `powershell -File speak.ps1 -Text "你好"`.

## Prerequisites

- Windows 10 or 11, PowerShell (any recent version).
- Natural voices:
  - **Windows 11**: natural voice packs are built into the system — no extra
    installation. Enable/switch them in *Settings → Accessibility → Narrator* or
    *Settings → Time & Language → Speech*.
  - **Windows 10**: install
    [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)
    and use its VoiceDownloader to download the natural voice pack(s) you want
    (Chinese or any other language).
- Without natural voices, the engine falls back to a stock voice (e.g. Huihui).

## Quick start — DSH

### Option A — npm plugin (recommended)

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

The engine ships inside the package (`node_modules/dsh-speak/engine/`), so no extra
copying is needed.

### Option B — file install (no npm needed)

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

## Quick start — Claude Code

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

## Quick start — any other harness

Call the engine directly from your agent / wrapper / script:

```powershell
# announce a one-liner
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speak.ps1 -Text "构建完成"

# announce a long summary (from a file)
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speech-summary.ps1 -Text "…"

# ask for user attention (blocking, for prompts/approvals)
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speech-prompt.ps1 -Text "请做出选择"
```

## Configuration

Engine parameters (see [docs/DESIGN.md](docs/DESIGN.md#5-configuration-reference)):

```powershell
speak.ps1 -Text "…" -Volume 50 -Rate 1 -MaxChars 300 -LongTextMessage "本次播报内容较长，请自行阅读。"
```

DSH plugin environment variables:

| var | default | meaning |
| --- | ------- | ------- |
| `DSH_SPEAK_ENGINE` | `%USERPROFILE%\.dsh\hooks\speak.ps1` | engine path |
| `DSH_SPEAK_THROTTLE_MS` | `1500` | merge delay before announcing |

## Troubleshooting

| symptom | cause | fix |
| ------- | ----- | --- |
| No sound at all, no error | no natural voice enabled/installed | Win11: enable a natural voice in *Settings → Narrator / Speech*; Win10: install NaturalVoiceSAPIAdapter + a voice pack. Test `speak.ps1` directly |
| Long replies never spoken | adapter per-`Speak` character ceiling | already guarded at 300 chars — lower `-MaxChars` if needed |
| Emoji-heavy text silent | SAPI fails silently on emoji | already stripped by the engine |
| Plugin not loading | raw Windows path as plugin name | use the `file:///C:/…` URL form (installer does this) |

Plugin diagnostics: `%TEMP%\dsh-speech-hook.log`.

## Repository layout

```
engine/                  harness-agnostic speech engine (PowerShell + SAPI5)
  speak.ps1              clean + speak (the only seam any adapter needs)
  speech-prompt.ps1      blocking short announcement
  speech-summary.ps1     blocking reply-summary announcement
adapters/
  dsh/                   DSH web plugin + one-command installer
    speech-hook.js       session-event trigger (throttle + tool-call cancel)
    install.ps1          copies + registers + backs up
  claude-code/
    stop-hook.ps1        Claude Code Stop hook trigger
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
