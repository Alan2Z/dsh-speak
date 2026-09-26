# DESIGN.md — dsh-speak: voice announcements for AI coding harnesses

English · [中文](DESIGN.zh-CN.md)

Status: **maintained** — this document describes the current implementation and
repository structure. It is the reference for the README.

---

## 1. Why

Agentic coding tools run long tasks (builds, tests, migrations, batch edits) while
you work on something else. When a reply finally lands you have to keep checking
the screen. **dsh-speak** reads the final reply aloud through system speech
synthesis (Windows SAPI5 / macOS `say`) so you know *without looking* that a long
task finished — and what its outcome was.

The original implementation was built and proven in a local DSH (DeepSeek Harness)
setup. This repository generalizes that working implementation into:

- a **harness-agnostic engine** (PowerShell + Windows SAPI5 / bash + macOS `say`)
  that any process can call,
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

- Linux/headless TTS is not supported (Windows uses `speak.ps1` + SAPI5; macOS
  uses `speak.sh` + the built-in `say`, shipped in the npm package since 1.2.0).
- In-repo packaging of NaturalVoiceSAPIAdapter (Windows 10 only) or voice data —
  they are prerequisites, not bundled.
- Per-voice audio files, non-Chinese voice curation (the speech **playback
  queue** is already implemented in 1.7.0 — see §3.2's host FIFO queue).

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
            |              engine/speak.ps1 / speak.sh (harness-agnostic)   |
            |   text -> clean (markdown/emoji/length) -> system speech      |
            +--------------------+------------------------------------------+
                     |                                   |
                     v                                   v
            Windows SAPI5 (System.Speech) —   macOS say (system voice):
              voices:                           * default follows the system
              * preferred: a natural voice —      voice (may be a Siri voice;
                 Windows 11 built-in pack, or      not listed by `say -v '?'`,
                 one registered by                 not selectable by name)
                 NaturalVoiceSAPIAdapter on      * or -v forces a classic voice
                 Windows 10 (e.g. "Microsoft      (Eddy / Tingting / Flo ...)
                 Xiaoxiao")                      * no volume flag (follows
              * fallback:  any zh voice (e.g.      the system output)
                 "Microsoft Huihui")
```

### 3.1 Engine — `engine/speak.ps1` (+ `engine/speak.sh` on macOS)

The only file a new adapter needs. Two input modes: `-Text "..."` inline, or
`-File C:\path\msg.txt` (UTF-8). Also `-Volume`, `-Rate`, `-MaxChars`,
`-LongTextMessage` (see §5). On macOS the plugin auto-picks `speak.sh` (the
`say` command; default voice follows the system — the Siri voices "声音 1-4"
are not exposed to `say`, use `-v` to force a name; no volume flag).

Processing pipeline (in order):

1. **Read** text (file read is always UTF-8).
2. **Strip markdown** — code blocks, inline code, links, bare URLs, emphasis chars.
3. **Strip emoji / non-printable** — keep CJK, CJK punctuation, full-width ranges,
   ASCII printable (regex `[^一-龥　-〿＀-￯ -⁯ -~]`).
4. **Collapse whitespace.**
5. **Length guard** — over `MaxChars` (default 300) the text is handled by
   `LongTextMode`: `message` (the default) replaces it with `LongTextMessage`
   (default: `本次播报内容较长，请自行阅读。`); `heading` speaks the largest
   markdown heading, or — when the text has no heading at all — a coherent
   opening: the leading `MaxChars` window trimmed back to its last sentence end
   (that fallback used to speak only the first line, which sounded like the
   narration was cut off).
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
- default mode: buffers the text and starts a throttle timer (default 1500 ms) to
  merge multi-step messages of one reply; a `tool/call` event **cancels** the
  pending announcement (that round's assistant text is process narration), but
  **`turn/end` fallback-announces the final reply** (tool-calling replies are
  still heard);
- **host speech queue** (1.7.0, from PR #2): every announcement (final reply,
  approvals, questions, optional events, manual replay) goes through a FIFO
  queue — only one native speech process runs at a time, queued items continue
  automatically. A `/dsh-speak/control` POST route (play/stop/status) and a
  `/dsh-speak/ws` WebSocket broadcast the authoritative speech state (which
  message is speaking, queue length).
- **Final-reply replay** (1.7.0): the 🔊 button in the turn-tail (final reply)
  action bar calls the control route to replay **that final message**; speech
  execution stays fully owned by the host (keeps speaking even with the browser
  closed).
- **`queueAllMessages` switch** (1.7.0, default off): off = throttled final
  reply + optional events (as before); on = every assistant message is enqueued
  immediately (intermediate messages spoken too).
- **Optional event announcements** (1.6.0, all off by default): `turn/end`,
  `command/done`, `goal/change`, `tool/result` (on error), and `todo/write` each
  have an independent toggle and announce a fixed phrase on fire (see §5).
- **Settings form** (1.6.0, reworked in 1.8.2 for DSH 0.1.7): the plugin exports a
  static `Config` schema (`module.exports.Config`, every field `.volatile()`), and
  the settings service projects it into the settings UI. The entry's **Loader id
  is the settings namespace** (`dsh-speak` in `cordis.patch.yml`), so there is
  nothing to register: `ctx.settings.describe()` reads the schema off the active
  entry, and the browser binds the same id through `ctx.configForms`. A write
  commits the new values into the running fiber's config *references* and emits
  `loader/volatile-update`; the plugin re-derives `cfg` there, which is what makes
  an edit audible without a restart. Resolution stays schema default → patch
  `config` → UI user layer.
  The schema must exist at module load: the Loader reads
  `module.exports.Config` right after importing the plugin, before any context
  exists, so it is built with `createRequire(__filename)` instead of the old
  `ctx.baseUrl` fallback. When the schemastery peer cannot be resolved, `Config`
  is `undefined`, the entry simply owns no settings page, and the plugin keeps
  running on the composed patch config — graceful degradation with no version
  check. `settings.configure({ auto: false }, ctx.fiber)` opts the entry out of
  the shell's automatically generated form, because the browser half ships a
  hand-written page.
  The plugin still never imports `@deepseek-ai/dsh-settings`: DSH 0.1.2-alpha.1
  deleted the `installSettingsSection` / `settingsNamespace` helpers (referencing
  them is fatal — a missing named export is a module-evaluation error, and the old
  lazy call threw `settingsNamespace is not a function` inside a timer callback,
  which crashed the host), and 0.1.7 then deleted the
  `settings.register(ns, schema, { base })` service API that had replaced them.

Registration snippet (also automated by `install.ps1`; npm installs use the bare
package name `'dsh-speak'` — this is the file-install path):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-speak
      # replace <your-username> with your Windows username
      name: 'file:///C:/Users/<your-username>/.dsh/profiles/web/plugins/speech-hook.js'
- id: dsh-speak
  name: 'file:///C:/Users/<your-username>/.dsh/profiles/web/plugins/speech-hook.js'
  config: {}
```

> Node's ESM loader does not accept Windows absolute paths as plugin names — the
> `file:///C:/...` URL form is required.

> **Two rows, and the shape is load-bearing.** The `insert` row provides the entry;
> the TOP-LEVEL row is the one the settings page persists into.
> `config-editor.edit()` rewrites a `config` in place only after finding a
> top-level, non-insert row with the same id+name (`document.setIn([index,
> "config"], …)`), and its `inherited()` helper strips `config` from exactly those
> rows to compute the base layer. A `config` nested inside the `insert` row — the
> shape 1.8.x profiles carry, and the obvious-looking one — is not addressable that
> way: the editor appends a fresh top-level row, that generation's
> `reconcileProfilePatches` runs, and the write is then rolled back. Observed
> symptom: the settings page answers `ok: true`, the running plugin obeys the edit
> immediately (the volatile refs are committed), the patch file flickers
> `3874 → 4345 → 3874` bytes, and the option silently reverts on the next boot.
> With the two-row shape the same edit lands in-place in ~0.3 s
> (`scripts/settings-ui-check.py` asserts the persistence).

> **Entry id = settings namespace.** Before 1.8.2 the id was `speech-hook` and the
> namespace was registered in code, so the two were independent; every 1.8.x
> profile patch therefore still says `speech-hook`. The browser half accepts both
> ids (`SETTINGS_NAMESPACES`) and binds whichever the Host serves, so upgrading
> needs no profile edit — only the *documented* id changed, and with it the key a
> fresh install stores its options under.

> **One entry per profile.** Two rows mounting this plugin (usually the bundle
> entry plus a leftover hand-written insert) would run two speech queues and
> double every announcement. `apply()` claims the process with a
> `Symbol.for('dsh-speak.active')` flag on `globalThis` (not a module variable: two
> rows may spell the same file differently, and Node would then evaluate the module
> twice, each copy seeing its own flag); the extra instance logs and stays inert,
> and the claim is released when the owning fiber disposes so a surviving row can
> take over.
>
> The guard covers **speech only**, and a duplicate entry id has a second,
> nastier consequence this half cannot fix: `config-editor.entries()` keeps only
> uniquely-ided entries (`counts.get(entry.options.id) === 1`), and its sanity
> check composes the candidate patches and compares `find(row => row.id === …)`
> — the FIRST row for that id — against the value it is writing. With the id
> present twice that comparison can never match, so **every settings write is
> refused** with `settings/rejected: Configuration for "dsh-speak" is overridden by
> a home patch or command-line overlay`, while speech keeps working normally. That
> is why the installer, the two READMEs and this note all insist on exactly one
> registration path (bundle entry **or** hand-written rows, never both), and why
> the log line for the duplicate names the settings symptom too.

### 3.4 DSH browser half — `client/client.js`

A DSH client bundle (`window.__ModuleLoader__.load({ id: 'dsh-speak', factory })`)
that registers two pieces of UI:

- **Turn-tail Speak button** (1.7.0, from PR #2): registered into the
  `conversation.chat.assistant-actions` slot (the turn's final-reply action bar).
  Clicking 🔊 POSTs to `/dsh-speak/control` to replay that final message; clicking
  again stops; clicking another switches. The button's speaking/paused state is
  derived from the authoritative host state over the `/dsh-speak/ws` WebSocket
  (matched by session + turn identity). The replayed text is resolved through the
  Chat target selector hook `useChat` (`@deepseek-ai/dsh-client-ui-chat` declares
  it for every session-scoped slot): DSH 0.1.2 excluded Conversation target data
  from the Session snapshot, so `useSession(s => s.chat.nodes)` no longer yields
  the chat nodes. The two selectors return primitives only, because a fresh
  object per read would churn the subscription, and a missing `useChat` prop
  degrades the button to disabled instead of throwing inside its row.
- **Settings → dsh-speak settings page** (1.7.0): registered into the
  `settings.section` slot, drawn with `@deepseek-ai/dsh-client-ui-primitives`
  (Button / DisclosureRow / Input; Toggle / Options / SettingInput helpers). Every
  option (master switch, automatic speech, queueAllMessages, Markdown cleaning,
  code blocks, maxChars, longTextMode, fixed prompt, approvals/questions, the five
  optional events) is read/written through `ctx.configForms.get(entryId)` — a
  snapshot (`status` / `value` / `writable`) plus `subscribe` / `set` / `unset`,
  the DSH 0.1.7 replacement for `settingsScope.bind({ namespace })`. The form is
  bound inside `ctx.configForms.whileServed(SETTINGS_NAMESPACES, …)`, so the page
  exists exactly while the Host actually serves one of those namespaces (and the
  bound `entryId` is the one it serves); `dsh-speak` is the documented id and
  `speech-hook` the pre-1.8.2 one.

- The package declares its browser half via `package.json`
  `dsh.client: { platform: 'web' }` + `exports['./client']`; DSH's client-modules
  scanner picks it up and loads it automatically. `dsh.client.inject` names the
  package rows that DECLARE the two slots it occupies
  (`@deepseek-ai/dsh-client-ui-chat`, `@deepseek-ai/dsh-client-ui-settings`) so
  their factories arrive first; `dsh.client.external` lists
  `@deepseek-ai/dsh-client-ui-primitives`, which the shell seeds in its static
  module table.
- **Deliberately handwritten, zero build**: it only uses platform seed modules
  and official primitives (the bundle-purity gate allows primitives but forbids
  importing official package internals), matching the built bundles' contract.

### 3.3 Claude Code adapter — `adapters/claude-code/stop-hook.ps1`

Claude Code *does* have a Stop hook. The hook JSON (with `transcript_path`) arrives
on stdin; the script scans the transcript backwards for the last assistant message
that contains text (the final entry is often a pure tool call), writes it to a temp
file and launches the engine in its own hidden powershell process, so the hook
returns immediately. (Async spawning is safe here — the nested-spawn restriction in
§6.3 is specific to DSH's sandbox.)

## 4. Event-flow truth table (DSH)

| assistant round / event          | announced? |
| -------------------------------- | ----------- |
| final text reply, no tool call   | ✅ after throttle |
| text + tool/call(s)              | 🟡 throttle cancelled (intermediate); **fallback-announced at turn end** |
| text + `ask_user_question` call  | ✅ each question announced separately: "问题N" prefix (when several) + "选项N" numbering, `questionGapMs` pause between questions |
| `approval/asked`                 | ✅ immediately (reason, else a fixed prompt) |
| reasoning only, no text          | ❌ (no text block) |
| streaming chunks                 | ❌ (filtered) |
| `turn/end`                       | 🟡 off by default; announces "第 N 轮对话完成/中断/异常结束" |
| `command/done`                   | 🟡 off by default; announces "命令执行完成/失败" |
| `goal/change`                    | 🟡 off by default; announces "已创建目标/目标已完成…" (head) |
| `tool/result`                    | 🟡 off by default; announces "工具调用出错" only for a structured failure (`error`, or a result block with `isError === true`). A non-zero shell exit is result data (`exit code: N`), not an error — pwsh/bash deliberately settle it as a completed call, so only infrastructure failures (spawn errors, aborts) and structured tool failures (e.g. fs) announce. Since 0.1.2 the `ToolResultBlock` wrapper nests the text under `content[]`, so the detail is read from there (English details / technical codes dropped, Chinese details kept) |
| `todo/write`                     | 🟡 off by default; announces "待办已更新：n/m 完成" |
| `assistant/message` (queueAllMessages on) | ✅ every message enqueued immediately (intermediate spoken too) |
| manual replay (per-message 🔊)   | ✅ clear queue → stop current → speak that turn |

## 5. Configuration reference

### Engine (`speak.ps1` parameters)

| param             | default                     | meaning                                  |
| ----------------- | --------------------------- | ---------------------------------------- |
| `-Text`           | `''`                        | inline text (used when `-File` is empty) |
| `-File`           | `''`                        | UTF-8 file to read                       |
| `-Volume`         | `50`                        | 0–100                                    |
| `-Rate`           | `1`                         | speech rate (SAPI scale)                 |
| `-MaxChars`       | platform                    | beyond this, replaced by `LongTextMessage` (macOS default 0 = unlimited) |
| `-LongTextMessage`| `本次播报内容较长，请自行阅读。` | spoken instead of over-long text         |
| `-LongTextMode`   | `message`                    | `message` (fixed prompt) \| `heading` (speak the largest markdown heading; **with no heading, speak a coherent opening**: the leading `MaxChars` window trimmed back to its last sentence end, kept whole when that would drop more than half the window. Full-width `。！？；…` always end a sentence; half-width `.!?;` only when followed by whitespace/a closing quote or bracket — read one character PAST the window for the last position, so an English `period + space` at the edge counts while `Version 0.1.` does not) |
| `-DryRun`         | `0`                          | print the text that WOULD be spoken as UTF-8 on stdout and exit without audio (maintainer aid for diffing the cleaning pipeline and the long-text guard) |
| `-CleanMarkdownFormatting` | `true`               | convert Markdown to natural speech (link labels kept, URLs stripped) |
| `-ReadInlineCode` | `true`                       | read inline code without backtick markers |
| `-CodeBlocks`     | `smart`                      | `all` \| `smart` \| `replace` (fenced code blocks) |
| `-CodeBlockMaxChars` | `300`                    | smart-mode code block character limit |
| `-CodeBlockReplacementText` | `You can see the code in our history.` | spoken in replace mode |

### DSH plugin (profile `config`; since 1.7.0 also editable in the Settings → dsh-speak settings page)

```yaml
config:
  enabled: true                # master switch
  automaticSpeech: true        # auto-speak final replies
  queueAllMessages: false      # true = enqueue every assistant message
  replayFullRead: false        # true = manual replay skips the long-text truncation
  cleanMarkdownFormatting: true
  readInlineCode: true
  codeBlocks: smart            # all | smart | replace
  codeBlockMaxChars: 300
  codeBlockReplacementText: 'You can see the code in our history.'
  throttleMs: 1500
  engine: ''                   # '' = auto-resolve
  announceApprovals: true
  announceQuestions: true
  stripApprovalPrefix: true
  questionGapMs: 2000          # pause between multiple question announcements (ms)
  longTextMode: message        # message | heading
  longTextMessage: '本次播报内容较长，请自行阅读。'
  maxChars: 300                # macOS default 0 = unlimited
  volume: 50                   # Windows only
  rate: 0                      # rate: Win SAPI scale -10..10 (0=normal) / mac wpm (175)
  # —— optional event announcements (off by default) ——
  announceTurnEnd: false     # turn/end
  announceCommandDone: false # command/done
  announceGoalChange: false  # goal/change
  announceToolErrors: false  # tool/result with error or isError block
  announceTodoWrite: false   # todo/write
```

Resolution order: schema default → patch `config` (base) → UI user layer. The
browser dsh-speak settings page (`client/client.js`) and the patch YAML read/write
the same profile patch: a UI write is a field operation (`set` / `unset` path op)
the settings service persists into the entry's `config` block. Platform note:
`maxChars` defaults to 0 on macOS (`say` has no ceiling) and 300 on Windows (SAPI
safe limit).

Full configuration guide: the README's Configuration section.

## 6. Pitfalls (hard-won; do not "fix" casually)

| # | pitfall | symptom | fix / rule |
|---|---------|---------|------------|
| 6.1 | Emoji / surrogate pairs reach `Speak()` | **silent** — no audio, no error | strip non-CJK/ASCII before speaking (engine step 3) |
| 6.2 | Text longer than the adapter's per-`Speak` ceiling (~375–470 chars) | **silent** — the whole utterance is dropped, not truncated | length guard at 300 chars (engine step 5) |
| 6.3 | Nested `Start-Process powershell` inside a DSH-sandboxed process | silent failure, no exception | keep the DSH chain synchronous at the adapter boundary (spawn once from the plugin; `speech-summary.ps1` calls `speak.ps1` synchronously) |
| 6.4 | Plugin name with a raw Windows path in `cordis.patch.yml` | plugin fails to load | `file:///C:/...` URL form |
| 6.5 | Matching adapter voices by name only | falls back to robotic stock voice | match `Name + Description` against `Natural\|Online` |
| 6.6 | Reading/writing speech text as ANSI | mojibake or empty speech | always UTF-8 (`[System.IO.File]::ReadAllText(..., UTF8)`) |
| 6.7 | A repo `.sh` checked out as CRLF by `core.autocrlf=true`; `npm pack` bundles the **working-tree** file | the published `speak.sh` dies in bash on macOS (`command not found`, `syntax error near {`), silent failure | `.gitattributes` pins `*.sh text eol=lf` (check `file engine/speak.sh` for CRLF before publishing) |
| 6.8 | Log path hard-coded as `/tmp` | on macOS `os.tmpdir()` is `/var/folders/.../T`, the log is not at `/tmp` | look for the log at `os.tmpdir()` (= `$TMPDIR`) |
| 6.9 | Engine `.ps1` saved **without the UTF-8 BOM** (any editor or script that rewrites the file drops it — it is byte metadata, not content, and nothing in the file records the requirement) | Windows PowerShell 5.1 decodes the file with the system ANSI code page, so Chinese **literals in code** become mojibake: the emoji/CJK filter then drops real text (silent no audio) or the sentence-end classes stop matching (silent wrong trimming). Comments only look garbled | two rules: (a) the engine's CODE stays ASCII-only — PowerShell punctuation is built from `[char]` code points and ranges are written as `\u` escapes, and `speak.sh`'s Perl guard writes punctuation as `\x{...}` escapes (Perl source is bytes without `use utf8`, so a Chinese literal in a pattern is read as Latin-1 and matches nothing — a macOS-only "trims nothing" bug 1.8.0 shipped and `npm test` caught it on a real machine) — so a lost BOM only garbles comments and the two default prompts; (b) `scripts/test-engine-static.js` asserts the BOM on every `engine/*.ps1` plus a PowerShell parse check (also in `prepublishOnly`), and `scripts/test-engine-longtext.js` asserts the extracted Perl guard is ASCII-only |

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

This repository stays **small and self-contained**: a small engine plus the two
adapter patterns (event-stream and stop-hook), and it is **actively maintained**.
If you need more (voice management UI, more backends, cross-platform), treat the
engine as the seam and build on top.

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

1. `config.engine` override;
2. `<package>/engine/speak.ps1` resolved relative to the plugin file — covers
   both a repo checkout and `node_modules/dsh-speak/` after `npm install`;
3. legacy `%USERPROFILE%\.dsh\hooks\speak.ps1` (the file-install location).

Because the engine rides inside the npm package, `dsh plugin --profile web add
dsh-speak` alone is sufficient — no separate copying step.

### Host requirement (`engines.dsh`)

`package.json` declares `engines.dsh: >=0.1.7-rc.2`. That one field is what
dsh-market reads to label the catalog card (`DSH >=0.1.7-rc.2`) and to decide
whether the plugin survives its "compatible with current DSH" filter:

- the facts come from the package's npm `latest` manifest
  (`{registry}/<pkg>/latest`, cached ~24 h) — the catalog YAML in
  `awesome-dsh-plugin` has no host field, so a PR there cannot declare this;
- an `engines.dsh` value is an `engine` declaration. Lockstep `@deepseek-ai/dsh*`
  **peers** count too, but non-lockstep host packages are skipped on purpose
  (`@deepseek-ai/schemastery`, `@deepseek-ai/cordis` — the schemastery peer above
  therefore declares nothing about the DSH version);
- all declarations are conjunctive and compared prerelease-aware, so
  `>=0.1.7-rc.2` matches a `0.1.7-rc.2` host; a missing declaration shows up as
  "host requirement undeclared", never as "incompatible";
- npm itself only enforces `engines.node` / `engines.npm`, so this key never
  blocks an install — it is marketplace metadata;
- move the floor only after a release has been verified against the new host, and
  update both READMEs with it: `scripts/test-manifest.js` asserts the same string
  appears in `package.json`, `README.md` and `README.zh-CN.md`.

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
#       - id: dsh-speak
#         name: 'dsh-speak'
# restart the DSH web app
```

> No pnpm installed? `dsh plugin` forwards to pnpm; the npm equivalent is
> (same result: package lands in the profile's `dependencies` + `node_modules`):
>
> - Windows (PowerShell):
>   `npm install --prefix "$env:USERPROFILE\.dsh\profiles\web" dsh-speak`
> - macOS (bash):
>   `npm install --prefix "$HOME/.dsh/profiles/web" dsh-speak`
>
> The patch watcher hot-reloads the plugin tree on `cordis.patch.yml` changes —
> verified: the plugin re-applies with the npm-bundled engine path, no restart
> needed for the registration switch itself (verified on macOS with 1.2.0).
