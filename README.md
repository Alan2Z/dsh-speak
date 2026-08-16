# dsh-speak 🔊 — Voice announcements for AI coding harnesses

**English** · [中文](README.zh-CN.md)

![鲸鱼娘大喇叭](鲸鱼娘大喇叭.png)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

Let your agent **tell you** when a long task is done — no more staring at the screen.

dsh-speak reads the final assistant reply aloud through system speech synthesis —
on Windows using natural voices (Windows 11 built-in, or
[NaturalVoiceSAPIAdapter] on Windows 10) with graceful fallback to stock voices;
on macOS using the built-in `say` (can follow a Siri natural voice). It was built
for [DeepSeek Harness](https://github.com/deepseek-ai/dsh)
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

   On macOS (bash):

   ```bash
   npm install --prefix "$HOME/.dsh/profiles/web" dsh-speak
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
      ▼  engine/speak.ps1 / speak.sh  (harness-agnostic: clean text → SAPI5 / say)
      ▼  🔊 you hear the final reply
```

## Features

- **Automatic**: DSH web plugin watches the session event stream and announces the
  final reply (skips reasoning/tool-call narration, merges multi-step messages).
- **Gets your attention**: announces approval requests (hears "需要你的审批" when
  the agent is waiting on you) and questions the agent asks via `ask_user_question`.
- **Best-effort**: never throws, never blocks the harness, never breaks a session.
- **Natural voices**: Windows prefers natural voices — Windows 11 built-in packs,
  or voices registered via NaturalVoiceSAPIAdapter on Windows 10 (e.g. Xiaoxiao);
  macOS uses the system reading voice (Siri natural voices on recent macOS). Both
  fall back to any installed voice.
- **Robust text cleaning**: strips markdown/URLs/emoji that make speech synthesis
  fail silently, and guards the adapter's per-utterance character ceiling.
- **Portable engine**: any process can speak with one line:
  Windows `powershell -File speak.ps1 -Text "你好"` / macOS `./speak.sh -t "你好"`.

## Prerequisites

Windows:

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

macOS:

- macOS (Apple Silicon or Intel), built-in `say` command — **no extra software**.
- Chinese voices: see the [macOS](#macos) section (incl. the Siri natural-voice
  picker and its pitfalls).

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

## macOS

The same adapter runs natively on macOS — the plugin auto-detects the platform and
calls `engine/speak.sh` (the built-in `say` command) instead of `speak.ps1`.
**Since 1.2.0 the macOS engine ships in the npm package** — no extra software.

### Install (npm — same as Windows)

```bash
# 1. install into your web profile (no pnpm needed — only `dsh plugin` requires it)
npm install --prefix "$HOME/.dsh/profiles/web" dsh-speak

# 2. register in ~/.dsh/profiles/web/cordis.patch.yml (bare package name — no file:/// URL):
#    - insert:
#        - id: speech-hook
#          name: 'dsh-speak'

# 3. no restart needed — the patch watcher hot-reloads; pure-text replies are
#    announced after ~1.5 s (tool-calling replies are intentionally not announced)
```

> With pnpm installed, `dsh plugin --profile web add dsh-speak` works identically.

### Voices (important — two pitfalls)

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

### Test the engine alone (no DSH needed)

```bash
curl -sfL -o ~/speak.sh "https://cdn.jsdelivr.net/gh/Alan2Z/dsh-speak@main/engine/speak.sh"
chmod +x ~/speak.sh
~/speak.sh -t "你好，Mac 版语音播报测试"
~/speak.sh -t "测试" -v Eddy -r 200              # explicit voice + rate
```

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
| `DSH_SPEAK_ENGINE` | empty (auto-resolved) | engine path override; otherwise resolved as `<package>/engine/<platform script>` → `~/.dsh/hooks/<platform script>` (Windows `speak.ps1` / macOS `speak.sh`) |
| `DSH_SPEAK_THROTTLE_MS` | `1500` | merge delay before announcing |

## Customizing (survives npm updates)

You can tune behavior without forking, and your changes **survive `npm update`**:

1. **Copy the engine out and edit it** (recommended — this is where defaults live: volume,
   rate, `MaxChars`, `LongTextMessage`, voice logic):

   ```powershell
   # Windows
   Copy-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-speak\engine\speak.ps1" "$env:USERPROFILE\.dsh\hooks\my-speak.ps1"
   # macOS
   cp ~/.dsh/profiles/web/node_modules/dsh-speak/engine/speak.sh ~/.dsh/hooks/my-speak.sh
   # edit my-speak.ps1 / my-speak.sh to taste, then point the plugin at it:
   setx DSH_SPEAK_ENGINE "$env:USERPROFILE\.dsh\hooks\my-speak.ps1"     # Windows
   echo 'export DSH_SPEAK_ENGINE=~/.dsh/hooks/my-speak.sh' >> ~/.zshrc  # macOS
   ```

   The plugin resolves the engine as `DSH_SPEAK_ENGINE` → package engine → `~/.dsh/hooks/`,
   so your copy wins. `npm update` only touches the package — your engine stays.

2. **Environment variables** (no code changes): `DSH_SPEAK_ENGINE` (engine path),
   `DSH_SPEAK_THROTTLE_MS` (announcement merge delay).

3. **Edit the file inside `node_modules`** — works, but the next `npm update` overwrites it.

4. **Fork the repo** — full control, publish your own package if you want.

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
