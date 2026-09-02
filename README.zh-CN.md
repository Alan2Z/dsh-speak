# dsh-speak 🔊 — 为 AI 编程 harness 提供语音播报

**中文** · [English](README.md)

![鲸鱼娘大喇叭](鲸鱼娘大喇叭.png)

[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)

[![npm version](https://img.shields.io/npm/v/dsh-speak)](https://www.npmjs.com/package/dsh-speak)

让 Agent 在长任务完成时**开口告诉你**——不用再盯着屏幕等。

dsh-speak 通过系统语音合成把 Agent 的最终回复朗读出来——Windows 上优先使用自然
语音（Windows 11 内置，或 Windows 10 上经
[NaturalVoiceSAPIAdapter] 注册，如晓晓），macOS 上使用系统自带的 `say`
（可跟随 Siri 自然音色）；没有时优雅回退到系统自带中文语音。本项目为
[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 而生，但结构上
任何 harness 都能接入。

## 特性

- **全自动**：DSH web 插件监听会话事件流，自动播报最终回复
  （跳过 reasoning/工具调用旁白，合并同一回复的多步消息）。
- **提醒你**：审批请求（Agent 等你操作时会播"需要你的审批"）和 Agent 通过
  `ask_user_question` 提出的问题都会播报。
- **最终回复重播**（1.7.0）：每条最终回复（回合尾部）操作栏有 🔊 按钮——点击
  重播该条回复、再点停止、点另一条切换。语音执行完全由 DSH host 拥有（浏览器
  关掉也继续读）。
- **host 语音队列**（1.7.0）：同一时间只运行一个语音进程，队列自动串行；
  WebSocket 实时同步"正在读哪条、队列长度"到 UI。
- **多事件可选播报**（1.6.0）：回合结束、命令完成、目标变更、工具出错、
  待办更新等事件都可选播报，各自独立开/关（默认关）。
- **可视化配置**（1.7.0）：设置 → dsh-speak 设置独立设置页，所有配置项（总开关、
  自动朗读、Markdown 清洗、代码块、事件开关、固定提示语…）直接改，无需手写
  YAML。
- **总开关**（1.6.0）：一键静音所有播报。
- **Bundle 自动注册**（1.3.0）：把包声明进 `dsh.profile.bundles`，插件通过包内
  自带的 `cordis.patch.yml` 自动注册，无需手动写 patch 条目。
- **尽力而为**：绝不抛错、绝不阻塞 harness、绝不破坏会话。
- **自然语音**：Windows 优先使用自然语音——Windows 11 内置语音包，或 Windows 10
  上经 NaturalVoiceSAPIAdapter 注册的语音（如晓晓）；macOS 使用系统朗读声音
  （新版可跟随 Siri 自然音色）。均回退到任意已安装语音。
- **健壮的文本清洗**：去掉会让语音合成静默失败的 markdown/URL/emoji，
  并守卫适配器单次朗读的字数上限。
- **引擎可移植**：任意进程一行即可朗读：
  Windows `powershell -File speak.ps1 -Text "你好"` / macOS `./speak.sh -t "你好"`。

## 工作原理

```
harness 事件（DSH 会话事件 / Claude Code Stop hook / 任意方式）
      │
      ▼  adapters/…  （harness 专属触发器：过滤、节流、取消）
      ▼  engine/speak.ps1 / speak.sh  （与 harness 无关：清洗文本 → SAPI5 / say）
      ▼  🔊 你听到最终回复
```

适配器负责把 harness 专属事件转成引擎调用；引擎负责清洗文本并朗读，
与 harness 完全解耦。完整设计见 [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md)。

## 前置条件

### Windows

- Windows 10 或 11，任意较新的 PowerShell。
- 自然语音：
  - **Windows 11（21H2–23H2）**：系统已内置自然语音包，无需额外安装——在
    *设置 → 辅助功能 → 讲述人* 或 *设置 → 时间和语言 → 语音* 中启用/切换即可。
  - **Windows 11 24H2/25H2**：自然语音已改为 MSIX 应用包，`System.Speech` 可能
    枚举不到（`SpeechSynthesizer` 找不到自然语音、回退到机械音）——与 Windows 10
    相同，需安装 [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)
    桥接。
  - **Windows 10**：需要安装
    [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)，
    并用它的 VoiceDownloader 手动下载你需要的中文或其他语言的自然语音包。
- 没有自然语音时，引擎回退到系统自带语音（如 Huihui）。

### macOS 要求

- macOS（Apple Silicon / Intel 均可），系统自带 `say` 命令，**无需安装任何软件**。
- 中文音色与 Siri 音色的选择入口/坑见 [macOS](#macos) 一节。

## 安装与快速开始

### DSH — 方式 A：npm 插件（推荐）

```powershell
# 1. 把插件装进你的 web profile（会写入 ~/.dsh/profiles/web/package.json 的 dependencies）
dsh plugin --profile web add dsh-speak

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 里注册（npm 包直接用包名，无需 file:/// URL）：
#    - insert:
#        - id: speech-hook
#          name: 'dsh-speak'

# 3. 重启 DSH web 应用 — 之后回复会被自动播报
```

> **没有 pnpm？** `dsh plugin` 内部转发给 pnpm，并非所有机器都装了。可以用 npm
> 直接完成同样的安装：
>
> ```powershell
> npm install --prefix "$env:USERPROFILE\.dsh\profiles\web" dsh-speak
> ```
>
> macOS（bash）：
>
> ```bash
> npm install --prefix "$HOME/.dsh/profiles/web" dsh-speak
> ```

引擎随包分发（`node_modules/dsh-speak/engine/`），无需额外拷贝。

> **想让 Agent 帮你装？** 把本仓库地址（`https://github.com/Alan2Z/dsh-speak`）
> 丢给你的 DSH 会话，让它照着这份 README 安装即可——它读的就是你正在看的这份文档。
> 只需要同意它对 `~/.dsh`（工作区外）的写入审批。

### DSH — 方式 B：文件安装（不需要 npm）

```powershell
# 1. 克隆
git clone https://github.com/Alan2Z/dsh-speak.git
cd dsh-speak

# 2. 一键安装：拷贝引擎 + 插件，并注册到 cordis.patch.yml
powershell.exe -NoProfile -ExecutionPolicy Bypass -File adapters\dsh\install.ps1

# 3. 验证引擎能出声
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\hooks\speak.ps1" -Text "你好，语音播报已就绪。"

# 4. 重启 DSH web 应用 — 之后回复会被自动播报
```

文件安装脚本做了这些事：

| 文件 | 目标位置 |
| ---- | -------- |
| `engine/*.ps1` | `%USERPROFILE%\.dsh\hooks\` |
| `adapters/dsh/speech-hook.js` | `%USERPROFILE%\.dsh\profiles\web\plugins\` |
| 注册条目 | 追加到 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`（先备份） |

### macOS

同一套适配层原生支持 macOS——插件自动检测平台，改调 `engine/speak.sh`
（系统自带的 `say` 命令）而不是 `speak.ps1`。**自 1.2.0 起 macOS 引擎随 npm 包
正式分发**，无需安装任何额外软件。

```bash
# 1. 装进你的 web profile（没有 pnpm 也能装——dsh plugin 才依赖 pnpm）
npm install --prefix "$HOME/.dsh/profiles/web" dsh-speak

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 末尾注册（裸包名即可，无需 file:/// URL）：
#    - insert:
#        - id: speech-hook
#          name: 'dsh-speak'

# 3. 无需重启——patch 监视器会热更新；回复在节流后（约 1.5 秒）自动播报；
#    带工具调用的回复会在回合结束时补播最终回复
```

> 装过 pnpm 也可以 `dsh plugin --profile web add dsh-speak`，效果相同。

#### 音色（重要，有两个坑）

- 默认跟随**系统朗读声音**（系统设置 → 辅助功能 → 朗读内容 → 系统朗读声音）。
  **macOS 26** 上该选择框旁有个 **ⓘ 圆圈图标**，点开才是完整音色列表——普通
  下拉框里**没有 Siri 自然音色**；可在 ⓘ 列表里选"普通话 Siri 声音1（男声）"等。
- **Siri 声音**（设置 → Siri → 声音）与系统朗读声音是**两个独立设置**；Siri
  音色不暴露给 `say -v '?'`，无法按名选择，只能作为系统默认生效。
- ⚠️ **坑 1（实测复现）**：打开"朗读内容 / Siri 声音"设置面板（**哪怕不改任何
  选项**）会把系统朗读声音漂移/重置成经典音色"婷婷(Tingting)"——音色突然变了
  就回到 ⓘ 入口重新选择。
- ⚠️ **坑 2**：日志在 `$TMPDIR/dsh-speech-hook.log`（`os.tmpdir()`，**不是**
  `/tmp`）。
- 想强制指定音色用 `-v Eddy|Flo|Tingting`（`say -v '?'` 列出可用音色）。
- `say` 没有音量参数——音量跟随系统输出音量。

#### 单独测试引擎（不装 DSH 也行）

```bash
curl -sfL -o ~/speak.sh "https://cdn.jsdelivr.net/gh/Alan2Z/dsh-speak@main/engine/speak.sh"
chmod +x ~/speak.sh
~/speak.sh -t "你好，Mac 版语音播报测试"
~/speak.sh -t "测试" -v Eddy -r 200              # 指定音色 + 语速
```

### Claude Code

在 `~/.claude/settings.json` 注册 Stop hook：

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

### 其他任何 harness

直接从你的 Agent / 包装脚本 / 工具里调用引擎：

```powershell
# 播报一句话
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speak.ps1 -Text "构建完成"

# 播报较长总结（阻塞，读完才返回）
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speech-summary.ps1 -Text "…"

# 需要用户注意时（阻塞，适合提问/授权场景）
powershell -NoProfile -ExecutionPolicy Bypass -File engine\speech-prompt.ps1 -Text "请做出选择"
```

## 配置

### 引擎参数

详见 [docs/DESIGN.zh-CN.md §5 配置参考](docs/DESIGN.zh-CN.md#5-配置参考)：

```powershell
speak.ps1 -Text "…" -Volume 50 -Rate 1 -MaxChars 300 -LongTextMessage "本次播报内容较长，请自行阅读。"
```

### DSH 插件配置

**两种改法，任选其一**（改 UI 或改 YAML 都写进同一个 settings 文档，彼此同步）：

1. **Web UI（1.7.0，推荐）**：设置 → dsh-speak 设置独立设置页。所有配置项都能直接改并
   保存（`dsh --dump-config` 可见、按 profile 隔离、升级不丢）。
2. **profile patch 的 `config` 块**（等效）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: speech-hook
      name: 'dsh-speak'
      config:
        enabled: true           # 总开关：false 时完全不播报
        automaticSpeech: true   # 自动朗读最终回复
        queueAllMessages: false # true = 所有 assistant 消息立即入队朗读（中间消息也读）
        replayFullRead: false   # true = 手动重播跳过超长文本截断，完整朗读
        cleanMarkdownFormatting: true # Markdown 转自然语音
        readInlineCode: true    # 朗读行内代码（去掉反引号）
        codeBlocks: smart       # all | smart | replace（围栏代码块）
        codeBlockMaxChars: 300  # smart 模式下的代码块字数上限
        codeBlockReplacementText: 'You can see the code in our history.' # replace 时的替代文本
        throttleMs: 1500        # 播报前的合并延迟（毫秒）
        engine: ''              # 引擎路径覆盖；'' = 自动解析
        announceApprovals: true # 播报审批请求
        announceQuestions: true # 播报 ask_user_question 提问内容
        stripApprovalPrefix: true  # 剥离审批原因里的 "escalate sandbox to ...: " 前缀
        questionGapMs: 2000      # 多个提问播报之间的停顿（毫秒）
        longTextMode: message   # message | heading（念最大字号 markdown 标题）
        longTextMessage: '本次播报内容较长，请自行阅读。' # message 模式下的固定提示语
        maxChars: 300           # 引擎单次朗读字数上限（macOS 默认 0 = 不限）
        volume: 50              # 仅 Windows
        rate: 0                 # 0 = 引擎默认（Windows SAPI 刻度 / macOS wpm）
        # —— 可选事件播报（1.6.0，默认全关）——
        announceTurnEnd: false     # 回合结束（"第 N 轮对话完成"）
        announceCommandDone: false # 命令完成/失败（command/done）
        announceGoalChange: false  # 目标创建/更新/完成（goal/change）
        announceToolErrors: false  # 工具调用出错时播报（英文详情截掉，tool/result）
        announceTodoWrite: false   # 待办列表更新（todo/write）
```

> 解析顺序：schema 默认值 → patch `config` → UI 用户设置。写进 YAML 的字段
> 同样出现在 UI 中。平台差异：`maxChars` 在 macOS 默认 0（`say` 无上限），
> Windows 默认 300（SAPI 安全上限）。

#### 选项说明

| 选项 | 默认值 | 效果 |
| ---- | ------ | ---- |
| `enabled` | `true` | **总开关**：关闭后所有播报都不触发（最终回复/审批/提问/可选事件/重播） |
| `automaticSpeech` | `true` | 自动朗读最终回复；手动重播始终可用 |
| `queueAllMessages` | `false` | `true` 时每条 assistant 消息立即入队朗读（中间消息也读，FIFO）；默认只读节流后的最终回复 |
| `replayFullRead` | `false` | `true` 时手动重播跳过超长文本的标题截断（`longTextMode: heading`），完整分段朗读 |
| `cleanMarkdownFormatting` | `true` | 把 Markdown 转成自然语音文本（链接保留文字去 URL、标题/强调符号清理） |
| `readInlineCode` | `true` | 朗读行内代码（去掉反引号标记） |
| `codeBlocks` | `smart` | 围栏代码块处理：`all` 全读 / `smart`（≤`codeBlockMaxChars` 才读）/ `replace` 用替代文本 |
| `codeBlockMaxChars` | `300` | `smart` 模式下的代码块字数上限 |
| `codeBlockReplacementText` | `You can see the code in our history.` | `replace` 模式（或超限的 `smart`）下朗读的替代文本 |
| `throttleMs` | `1500` | 回复文本等待多久才播报（合并同一回复的多步消息） |
| `engine` | `''` | 显式引擎脚本路径；`''` 自动解析：包内 `engine/<平台>` → `~/.dsh/hooks/<平台>` |
| `announceApprovals` | `true` | 播报 `approval/asked` 事件（审批原因，或固定提示语） |
| `announceQuestions` | `true` | 播报 `ask_user_question`：每个问题单独朗读，带"问题N"序号（多问题时）与"选项N"序号（与 UI 编号一致）；多个问题之间停顿 `questionGapMs` |
| `questionGapMs` | `2000` | 多个提问播报之间的停顿（毫秒），0 = 不停顿 |
| `stripApprovalPrefix` | `true` | 剥离审批原因里的固定英文模板前缀（`escalate sandbox to danger-full-access: `），保留中文说明 |
| `longTextMode` | `message` | `message` = 超长念固定提示语；`heading` = 改念最大字号 markdown 标题（规则见下） |
| `longTextMessage` | `本次播报内容较长，请自行阅读。` | `message` 模式下超长文本改念的固定提示语（UI 可编辑） |
| `maxChars` | 平台相关 | 引擎单次朗读上限。**macOS 默认 0（`say` 无上限）；Windows 默认 300**（SAPI 超过约 375-470 字会静默失败） |
| `volume` | `50` | 仅 Windows（0-100）；macOS 音量跟随系统 |
| `rate` | `0` | 语速：Windows SAPI 刻度（-10 到 10，0 = 正常，推荐 0 / 稍快 1-3）；macOS words-per-minute（默认 175，稍快 200） |
| `announceTurnEnd` | `false` | 回合结束时播报"第 N 轮对话完成/中断/异常结束"（`turn/end`） |
| `announceCommandDone` | `false` | 命令执行完成/失败时播报（`command/done`） |
| `announceGoalChange` | `false` | 目标创建/更新/完成/暂停/恢复时播报（`goal/change`，含目标标题前 40 字） |
| `announceToolErrors` | `false` | 工具调用返回错误时播报"工具调用出错"（英文错误详情/技术 code 截掉，只保留中文详情；`tool/result` 带 `error` 或 `isError` 内容块时） |
| `announceTodoWrite` | `false` | agent 更新待办列表时播报"待办已更新：n/m 完成"（`todo/write`） |

#### 超长文本模式

清洗后文本超过 `maxChars` 时：

- **`message`**（默认）：念 `longTextMessage`（`本次播报内容较长，请自行阅读。`，
  可在 UI 或 YAML 里编辑）。
- **`heading`**：在原始文本里挑**最大字号**的 markdown 标题——`#` 数量最少者优先，
  并列取第一个；没有标题行则取第一个非空行。选中的候选仍会清洗并受 `maxChars`
  上限约束，若其本身仍超长则回退提示语。

完整架构与设计取舍见 [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md)。

## 自定义（升级不丢）

想调行为又不想 fork，而且改完**不会被 `npm update` 覆盖**：

1. **把引擎复制出来改**（推荐——默认参数都在这：音量、语速、字数上限、超长提示语、音色逻辑）：

   ```powershell
   # Windows
   Copy-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-speak\engine\speak.ps1" "$env:USERPROFILE\.dsh\hooks\my-speak.ps1"
   # macOS
   cp ~/.dsh/profiles/web/node_modules/dsh-speak/engine/speak.sh ~/.dsh/hooks/my-speak.sh
   ```

   然后在 config 块里指向你的副本：

   ```yaml
   - insert:
       - id: speech-hook
         name: 'dsh-speak'
         config:
           engine: 'C:/Users/<你>/.dsh/hooks/my-speak.ps1'   # macOS 用 ~/.dsh/hooks/my-speak.sh
   ```

   插件按 `config.engine` → 包内引擎 → `~/.dsh/hooks/` 的顺序解析引擎，所以你的副本
   优先生效；`npm update` 只动包本身，你的引擎安然无恙。

2. **直接改 `node_modules` 里的文件**——能改，但下次 `npm update` 会被覆盖。

3. **fork 仓库**——完全掌控，想发自己的包也行。

## 排障

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| 完全没有声音、无报错 | 未启用/安装自然语音 | Win11：在 设置 → 讲述人/语音 中启用自然语音；Win10：安装 NaturalVoiceSAPIAdapter 并下载语音包。直接测 `speak.ps1` |
| 长回复从不播报 | 适配器单次 `Speak` 有字数上限 | 已默认在 300 字处守卫——必要时调低 `-MaxChars` |
| 含大量 emoji 的文本静默 | SAPI 遇到 emoji 会静默失败 | 引擎已自动剥离 |
| 插件加载失败 | 插件名用了 Windows 原始路径 | 改用 `file:///C:/…` URL 形式（安装脚本会自动处理） |
| macOS：音色突然变成"婷婷" | 打开过"朗读内容 / Siri 声音"设置面板导致系统朗读声音漂移 | 系统设置 → 辅助功能 → 阅读与朗读 → 系统声音 → ⓘ 入口重新选择 |
| macOS：在 `/tmp` 找不到日志 | `os.tmpdir()` 是 `/var/folders/.../T`，不是 `/tmp` | 日志在 `$TMPDIR/dsh-speech-hook.log` |

插件诊断日志：Windows `%TEMP%\dsh-speech-hook.log`；macOS `$TMPDIR/dsh-speech-hook.log`

## 仓库结构

```
engine/                  与 harness 无关的语音引擎（PowerShell + SAPI5 / bash + say）
  speak.ps1 / speak.sh   清洗 + 朗读（适配层唯一需要打交道的接口）
  speech-prompt.ps1      阻塞式短提示播报
  speech-summary.ps1     阻塞式回复总结播报
adapters/
  dsh/                   DSH web 插件 + 一键安装脚本
    speech-hook.js       会话事件触发器（节流/取消 + 可选事件 + FIFO 语音队列 + WebSocket + settings 注册）
    install.ps1          拷贝 + 注册 + 备份
  claude-code/
    stop-hook.ps1        Claude Code Stop hook 触发器
client/
  client.js              DSH 浏览器端 bundle：回合尾部 Speak/Stop 按钮 + 设置 → dsh-speak 设置页
docs/
  DESIGN.zh-CN.md        完整设计文档：设计取舍、踩坑记录、扩展指南
```

## 编写新适配器

三种参考模式：**事件流**（DSH）、**Stop hook**（Claude Code）、**Agent 自调用**
（在 shell 里调 `speech-summary.ps1`）。无论哪种，适配器只需做一件事：
拿到*最终回复文本* → 调用引擎。详见
[docs/DESIGN.zh-CN.md §7 扩展](docs/DESIGN.zh-CN.md#7-扩展)。

## License

MIT — 见 [LICENSE](LICENSE)。

[NaturalVoiceSAPIAdapter]: https://github.com/gexgd0419/NaturalVoiceSAPIAdapter
