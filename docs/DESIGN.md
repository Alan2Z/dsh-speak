# DESIGN.md — dsh-speak: voice announcements for AI coding harnesses

English · [中文](DESIGN.zh-CN.md)

Status: **draft** — this document describes the current (proven) local implementation
and the target generic structure of this repository. It is the reference for the
README.

---

## 1. Why

Agentic coding tools run long tasks (builds, tests, migrations, batch edits) while
you work on something else. When a reply finally lands you have to keep checking
the screen. **dsh-speak** reads the final reply aloud through Windows speech
synthesis so you know *without looking* that a long task finished — and what its
outcome was.

The original implementation was built and proven in a local DSH (DeepSeek Harness)
setup. This repository generalizes that working implementation into:

- a **harness-agnostic engine** (PowerShell + Windows SAPI5) that any process can call,
- **adapter layers** that turn harness-specific events into engine calls
  (DSH session events, Claude Code Stop hooks, ...).

## 2. Goals / non-goals

Goals:

- One-command install for DSH users (engine + plugin + registration).
- Engine callable from any harness via a trivial command line.
- Best-effort speech: never throws, never blocks a harness, never breaks a session.
- Natural-sounding voices: Windows 11 built-in natural voice packs, or
  NaturalVoiceSAPIAdapter on Windows 10; graceful fallback to stock voices.

Non-goals (for now):

- Cross-platform engines (macOS/Linux TTS). Windows-only by design.
- In-repo packaging of NaturalVoiceSAPIAdapter (Windows 10 only) or voice data —
  they are prerequisites, not bundled.
- Streaming/queued playback, per-voice audio files, non-Chinese voice curation.

## 3. Architecture

```
            +--------------------------------------------------------------+
            |                         harness                               |
            |   (DSH web app  |  Claude Code  |  anything with a shell)     |
            +--------+-----------------------------+-----------------------+
                     |                             |
                     | session events              | Stop hook JSON (stdin)
                     v                             v
            +------------------+         +--------------------------+
            |  adapters/dsh/   |         | adapters/claude-code/    |
            |  speech-hook.js  |         | stop-hook.ps1            |
            |  (event filter,  |         | (transcript extraction)  |
            |   throttle,      |         +------------+-------------+
            |   cancel)        |                      |
            +--------+---------+                      |
                     | text                           | text
                     v                                v
            +---------------------------------------------------------------+
            |                   engine/speak.ps1  (harness-agnostic)        |
            |   text -> clean (markdown/emoji/length) -> SAPI5 Speak()      |
            +---------------------------------------------------------------+
                     |
                     v
            Windows SAPI5 (System.Speech) — voices:
              * preferred: a natural voice — Windows 11 built-in pack, or one
                registered by NaturalVoiceSAPIAdapter on Windows 10
                (e.g. "Microsoft Xiaoxiao")
              * fallback:  any zh voice (e.g. "Microsoft Huihui")
```

### 3.1 Engine — `engine/speak.ps1`

The only file a new adapter needs. Two input modes: `-Text "..."` inline, or
`-File C:\path\msg.txt` (UTF-8). Also `-Volume`, `-Rate`, `-MaxChars`,
`-LongTextMessage` (see §5).

Processing pipeline (in order):

1. **Read** text (file read is always UTF-8).
2. **Strip markdown** — code blocks, inline code, links, bare URLs, emphasis chars.
3. **Strip emoji / non-printable** — keep CJK, CJK punctuation, full-width ranges,
   ASCII printable (regex `[^一-龥　-〿＀-￯ -⁯ -~]`).
4. **Collapse whitespace.**
5. **Length guard** — if cleaned text exceeds `MaxChars` (default 300), replace with
   `LongTextMessage` (default: `本次播报内容较长，请自行阅读。`).
6. **Speak** — `System.Speech.Synthesis.SpeechSynthesizer`, volume/rate applied,
   best zh natural voice selected, then `Speak()`.

Engine contract for adapters:

- exit 0 always; never writes to stdout/stderr on failure paths;
- synchronous (returns when the utterance finishes, or immediately on any failure);
- safe to call from a sandboxed process *provided* the caller does not need to nest
  another `powershell.exe` inside a harness sandbox (see §6.3).

### 3.2 DSH adapter — `adapters/dsh/speech-hook.js`

A DSH web-profile plugin (Cordis plugin) registered via `cordis.patch.yml`. DSH has
no "reply finished" hook, so the plugin observes the session event stream:

- listens to `session/event`;
- filters `assistant/message` events with `surfaceOp == 'append'`;
- extracts only `text` content blocks (reasoning / tool_use blocks are skipped);
- buffers the text and starts a throttle timer (default 1500 ms) to merge
  multi-step messages of one reply;
- a `tool/call` event **cancels** the pending announcement — that round's assistant
  text is process narration, not the final reply;
- on fire: writes the text to a temp file and `spawn`s
  `powershell.exe -File <engine> -File <tmp>` with `windowsHide` + `stdio: 'ignore'`
  so the harness is never blocked; the temp file is deleted on exit.

Registration snippet (also automated by `install.ps1`):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: speech-hook
      # replace <your-username> with your Windows username
      name: 'file:///C:/Users/<your-username>/.dsh/profiles/web/plugins/speech-hook.js'
```

> Node's ESM loader does not accept Windows absolute paths as plugin names — the
> `file:///C:/...` URL form is required.

### 3.3 Claude Code adapter — `adapters/claude-code/stop-hook.ps1`

Claude Code *does* have a Stop hook. The hook JSON (with `transcript_path`) arrives
on stdin; the script scans the transcript backwards for the last assistant message
that contains text (the final entry is often a pure tool call), writes it to a temp
file and launches the engine in its own hidden powershell process, so the hook
returns immediately. (Async spawning is safe here — the nested-spawn restriction in
§6.3 is specific to DSH's sandbox.)

## 4. Event-flow truth table (DSH)

| assistant round contains        | announced? |
| ------------------------------- | ----------- |
| final text reply, no tool call  | ✅ after throttle |
| text + tool/call(s)             | ❌ (cancelled — narration) |
| reasoning only, no text         | ❌ (no text block) |
| streaming chunks                | ❌ (filtered) |

## 5. Configuration reference

### Engine (`speak.ps1` parameters)

| param             | default                     | meaning                                  |
| ----------------- | --------------------------- | ---------------------------------------- |
| `-Text`           | `''`                        | inline text (used when `-File` is empty) |
| `-File`           | `''`                        | UTF-8 file to read                       |
| `-Volume`         | `50`                        | 0–100                                    |
| `-Rate`           | `1`                         | speech rate (SAPI scale)                 |
| `-MaxChars`       | `300`                       | beyond this, replaced by `LongTextMessage` |
| `-LongTextMessage`| `本次播报内容较长，请自行阅读。` | spoken instead of over-long text         |

### DSH plugin (environment variables)

| var                  | default                                  | meaning                        |
| -------------------- | ---------------------------------------- | ------------------------------ |
| `DSH_SPEAK_ENGINE`   | `%USERPROFILE%\.dsh\hooks\speak.ps1`     | engine path                    |
| `DSH_SPEAK_THROTTLE_MS` | `1500`                                | merge delay before announcing  |

## 6. Pitfalls (hard-won; do not "fix" casually)

| # | pitfall | symptom | fix / rule |
|---|---------|---------|------------|
| 6.1 | Emoji / surrogate pairs reach `Speak()` | **silent** — no audio, no error | strip non-CJK/ASCII before speaking (engine step 3) |
| 6.2 | Text longer than the adapter's per-`Speak` ceiling (~375–470 chars) | **silent** — the whole utterance is dropped, not truncated | length guard at 300 chars (engine step 5) |
| 6.3 | Nested `Start-Process powershell` inside a DSH-sandboxed process | silent failure, no exception | keep the DSH chain synchronous at the adapter boundary (spawn once from the plugin; `speech-summary.ps1` calls `speak.ps1` synchronously) |
| 6.4 | Plugin name with a raw Windows path in `cordis.patch.yml` | plugin fails to load | `file:///C:/...` URL form |
| 6.5 | Matching adapter voices by name only | falls back to robotic stock voice | match `Name + Description` against `Natural\|Online` |
| 6.6 | Reading/writing speech text as ANSI | mojibake or empty speech | always UTF-8 (`[System.IO.File]::ReadAllText(..., UTF8)`) |

## 7. Extending

### New engine backend
The engine is the single seam for TTS backends. A future `speak-edge.ps1` could
wrap `edge-tts`, or a `speak-piper.ps1` a local offline model — same parameter
contract, same cleaning pipeline, swap the `Speak()` step. Adapters never change.

### New harness adapter
Implement: *capture the final reply text → call the engine*. DSH (event stream),
Claude Code (Stop hook), and any shell-based harness (`speech-summary.ps1` called
by the agent) are the three reference patterns.

## 8. Scope

This project is intentionally **not** a living product. It documents one proven way
to give a harness a voice: a small engine + the two adapter patterns (event-stream
and stop-hook) that worked. If you need more (voice management UI, more backends,
cross-platform), treat the engine as the seam and build on top — this repository
stays as a minimal, self-contained reference implementation.

## 9. Publishing as an npm plugin (appendix)

The DSH plugin mechanism is Cordis-based, and the official install path for
out-of-tree plugins is `dsh plugin --profile web add <package>` (pnpm-managed
dependencies in the profile). This repository is prepared for that path:

### Package layout

- `package.json` — `name: dsh-speak`, `main: adapters/dsh/speech-hook.js`,
  `files` whitelists exactly what ships (plugin, `engine/*.ps1`, `install.ps1`,
  docs, license). `prepublishOnly` runs `node --check` on the plugin.
- The plugin entry is the same CJS module (`module.exports = { apply(ctx) }`)
  already used by the file install — no code change is needed to publish.

### Engine resolution (npm vs file install)

`speech-hook.js` locates `engine/speak.ps1` in this order:

1. `DSH_SPEAK_ENGINE` environment override;
2. `<package>/engine/speak.ps1` resolved relative to the plugin file — covers
   both a repo checkout and `node_modules/dsh-speak/` after `npm install`;
3. legacy `%USERPROFILE%\.dsh\hooks\speak.ps1` (the file-install location).

Because the engine rides inside the npm package, `dsh plugin --profile web add
dsh-speak` alone is sufficient — no separate copying step.

### Publish steps (maintainer)

```powershell
npm login --registry=https://registry.npmjs.org   # official registry, 2FA required
npm publish                                       # publishConfig.registry pins the official registry
# bump "version" in package.json before every subsequent publish
```

> China note: if your global `.npmrc` points at a mirror (`registry.npmmirror.com`
> etc.), `npm login`/`npm publish` would target the mirror, which does **not**
> accept publishes. The package's `publishConfig.registry` pins publishing to the
> official registry; just make sure the login used the official registry too.

### Install steps (DSH user)

```powershell
dsh plugin --profile web add dsh-speak
# then register in ~/.dsh/profiles/web/cordis.patch.yml:
#   - insert:
#       - id: speech-hook
#         name: 'dsh-speak'
# restart the DSH web app
```

> No pnpm installed? `dsh plugin` forwards to pnpm; the npm equivalent is
> `npm install --prefix "$env:USERPROFILE\.dsh\profiles\web" dsh-speak`
> (same result: package lands in the profile's `dependencies` + `node_modules`).
> The patch watcher hot-reloads the plugin tree on `cordis.patch.yml` changes —
> verified: the plugin re-applies with the npm-bundled engine path, no restart
> needed for the registration switch itself.
