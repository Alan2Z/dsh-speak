# DESIGN.zh-CN.md — dsh-speak：为 AI 编程 harness 提供语音播报

状态：**草稿** — 本文档描述当前（已验证的）本地实现与本文档仓库的目标通用结构，
是 README 的参考依据。

（英文版：docs/DESIGN.md）

---

## 1. 为什么

Agent 工具会跑长任务（构建、测试、迁移、批量修改），而你正在忙别的。回复终于落地时，
你不得不反复看屏幕。**dsh-speak** 通过 Windows 语音合成把最终回复读出来，让你
*不用看屏幕* 就知道长任务完成了——以及结果是什么。

最初实现是在本地 DSH（DeepSeek Harness）环境里搭建并验证过的。本仓库把这份可用的
实现通用化为：

- **与 harness 无关的引擎**（PowerShell + Windows SAPI5），任意进程都可调用；
- **适配层**，把 harness 专属事件转成引擎调用（DSH 会话事件、Claude Code Stop hook…）。

## 2. 目标 / 非目标

目标：

- DSH 用户一键安装（引擎 + 插件 + 注册）。
- 引擎可通过一行命令行从任意 harness 调用。
- 尽力而为的播报：绝不抛错、绝不阻塞 harness、绝不破坏会话。
- 自然语音：Windows 11 内置自然语音包，或 Windows 10 上经 NaturalVoiceSAPIAdapter
  注册；优雅回退到系统自带语音。

非目标（当前阶段）：

- 跨平台引擎（macOS/Linux TTS）。设计上仅限 Windows。
- 在仓库内打包 NaturalVoiceSAPIAdapter（仅 Windows 10 需要）或语音数据——
  它们是前置依赖，不打进仓库。
- 流式/队列播放、按音色输出音频文件、非中文音色管理。

## 3. 架构

```
            +--------------------------------------------------------------+
            |                         harness                              |
            |   (DSH web 应用  |  Claude Code  |  任何有 shell 的东西)     |
            +--------+-----------------------------+-----------------------+
                     |                             |
                     | 会话事件                     | Stop hook JSON (stdin)
                     v                             v
            +------------------+         +--------------------------+
            |  adapters/dsh/   |         | adapters/claude-code/    |
            |  speech-hook.js  |         | stop-hook.ps1            |
            |  (事件过滤、     |         | (transcript 提取)        |
            |   节流、取消)    |         +------------+-------------+
            +--------+---------+                      |
                     | 文本                           | 文本
                     v                                v
            +---------------------------------------------------------------+
            |               engine/speak.ps1  （与 harness 无关）           |
            |   文本 -> 清洗(markdown/emoji/长度) -> SAPI5 Speak()          |
            +---------------------------------------------------------------+
                     |
                     v
            Windows SAPI5 (System.Speech) — 音色：
              * 优先：自然语音 — Windows 11 内置语音包，或 Windows 10 上经
                NaturalVoiceSAPIAdapter 注册（如 "Microsoft Xiaoxiao"）
              * 回退：任意 zh 语音（如 "Microsoft Huihui"）
```

### 3.1 引擎 — `engine/speak.ps1`

新适配器唯一需要打交道的文件。两种输入模式：`-Text "..."` 直接传入，或
`-File C:\path\msg.txt`（UTF-8）。另有 `-Volume`、`-Rate`、`-MaxChars`、
`-LongTextMessage`（见 §5）。

处理管线（按顺序）：

1. **读取**文本（读文件一律 UTF-8）。
2. **剥离 markdown** — 代码块、行内代码、链接、裸 URL、强调符号。
3. **剥离 emoji / 不可打印字符** — 只保留中文汉字、中文标点、全角区间、
   ASCII 可打印（正则 `[^一-龥　-〿＀-￯ -⁯ -~]`）。
4. **压缩空白。**
5. **长度守卫** — 清洗后文本超过 `MaxChars`（默认 300）时，替换为
   `LongTextMessage`（默认：`本次播报内容较长，请自行阅读。`）。
6. **朗读** — `System.Speech.Synthesis.SpeechSynthesizer`，应用音量/语速，
   选择最佳 zh 自然语音，然后 `Speak()`。

引擎对适配器的契约：

- 总是以 0 退出；失败路径不向 stdout/stderr 写内容；
- 同步（读完整个句子才返回，或任何失败时立即返回）；
- 沙箱进程可安全调用，*前提* 是调用方不需要在 harness 沙箱内再嵌套一个
  `powershell.exe`（见 §6.3）。

### 3.2 DSH 适配层 — `adapters/dsh/speech-hook.js`

一个 DSH web 配置插件（Cordis 插件），通过 `cordis.patch.yml` 注册。DSH 没有
"回复完成" hook，所以插件观察会话事件流：

- 监听 `session/event`；
- 过滤 `assistant/message` 且 `surfaceOp == 'append'` 的事件；
- 只提取 `text` 内容块（reasoning / tool_use 块跳过）；
- 缓冲文本并启动节流定时器（默认 1500 ms）以合并同一回复的多步消息；
- `tool/call` 事件会**取消**待播报——该轮 assistant 文本是过程旁白，不是最终回复；
- 触发时：把文本写入临时文件，`spawn` 出
  `powershell.exe -File <engine> -File <tmp>`，带 `windowsHide` + `stdio: 'ignore'`，
  绝不阻塞 harness；退出后删除临时文件。

注册片段（`install.ps1` 也会自动完成）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: speech-hook
      # 把 <your-username> 换成你的 Windows 用户名
      name: 'file:///C:/Users/<your-username>/.dsh/profiles/web/plugins/speech-hook.js'
```

> Node 的 ESM 加载器不接受 Windows 绝对路径作为插件名——必须用
> `file:///C:/...` URL 形式。

### 3.3 Claude Code 适配层 — `adapters/claude-code/stop-hook.ps1`

Claude Code *确实*有 Stop hook。hook JSON（含 `transcript_path`）从 stdin 传入；
脚本从后往前扫描 transcript，找最后一条含文本的 assistant 消息（末尾常常是纯
工具调用），写入临时文件后在自己独立的隐藏 powershell 进程里启动引擎，hook 立即
返回。（此处异步 spawn 是安全的——§6.3 的嵌套限制仅存在于 DSH 沙箱内。）

## 4. 事件流真值表（DSH）

| assistant 轮次包含                | 是否播报 |
| --------------------------------- | -------- |
| 最终文本回复，无工具调用          | ✅ 节流后播报 |
| 文本 + tool/call(s)               | ❌（取消——旁白） |
| 只有 reasoning，无文本            | ❌（无 text 块） |
| 流式分块                          | ❌（被过滤） |

## 5. 配置参考

### 引擎（`speak.ps1` 参数）

| 参数 | 默认值 | 含义 |
| ---- | ------ | ---- |
| `-Text` | `''` | 内联文本（`-File` 为空时使用） |
| `-File` | `''` | 要读取的 UTF-8 文件 |
| `-Volume` | `50` | 0–100 |
| `-Rate` | `1` | 语速（SAPI 刻度） |
| `-MaxChars` | `300` | 超过此长度时替换为 `LongTextMessage` |
| `-LongTextMessage` | `本次播报内容较长，请自行阅读。` | 超长文本时改念这句 |

### DSH 插件（环境变量）

| 变量 | 默认值 | 含义 |
| ---- | ------ | ---- |
| `DSH_SPEAK_ENGINE` | `%USERPROFILE%\.dsh\hooks\speak.ps1` | 引擎路径 |
| `DSH_SPEAK_THROTTLE_MS` | `1500` | 播报前的合并延迟（毫秒） |

## 6. 踩坑记录（来之不易；不要随意"修复"）

| # | 坑 | 现象 | 修复/规则 |
|---|-----|------|-----------|
| 6.1 | emoji / 代理对进入 `Speak()` | **静默**——没声音也没报错 | 朗读前剥离非 CJK/ASCII 字符（引擎第 3 步） |
| 6.2 | 文本超过适配器单次 `Speak` 上限（约 375–470 字） | **静默**——整段被丢弃，而不是截断 | 300 字长度守卫（引擎第 5 步） |
| 6.3 | 在 DSH 沙箱进程内嵌套 `Start-Process powershell` | 静默失败，无异常 | DSH 链路在适配器边界保持同步（插件只 spawn 一次；`speech-summary.ps1` 同步调用 `speak.ps1`） |
| 6.4 | `cordis.patch.yml` 里插件名用 Windows 原始路径 | 插件加载失败 | 用 `file:///C:/...` URL 形式 |
| 6.5 | 只按名字匹配适配器音色 | 回退到机械感的系统语音 | 用 `Name + Description` 匹配 `Natural\|Online` |
| 6.6 | 用 ANSI 读写播报文本 | 乱码或完全无声 | 一律 UTF-8（`[System.IO.File]::ReadAllText(..., UTF8)`） |

## 7. 扩展

### 新的引擎后端
引擎是 TTS 后端的唯一接缝。未来可以加 `speak-edge.ps1`（封装 `edge-tts`）或
`speak-piper.ps1`（本地离线模型）——同样的参数契约、同样的清洗管线，只换
`Speak()` 这一步。适配层永远不用改。

### 新的 harness 适配层
实现思路：*捕获最终回复文本 → 调用引擎*。DSH（事件流）、Claude Code（Stop
hook）、任意 shell harness（Agent 自己调 `speech-summary.ps1`）就是三种参考范式。

## 8. 项目定位

本项目**刻意不是**一个持续迭代的产品。它记录了一条被验证过的、让 harness
开口说话的实现路径：一个小引擎 + 两种可复用的适配范式（事件流 / Stop hook）。
如果你需要更多（音色管理界面、更多后端、跨平台），把引擎当作接缝在其上扩展——
本仓库保持为最小、自包含的参考实现。

## 9. 发布为 npm 插件（附录）

DSH 的插件机制基于 Cordis，官方安装树外插件的路径是
`dsh plugin --profile web add <包名>`（由 pnpm 管理 profile 依赖）。本仓库已为
该路径做好准备：

### 包结构

- `package.json` — `name: dsh-speak`，`main: adapters/dsh/speech-hook.js`，
  `files` 白名单精确列出发布内容（插件、`engine/*.ps1`、`install.ps1`、文档、
  LICENSE）。`prepublishOnly` 会对插件跑 `node --check`。
- 插件入口就是文件安装已用的同一个 CJS 模块（`module.exports = { apply(ctx) }`）
  ——发布**不需要改任何代码**。

### 引擎解析（npm 安装 vs 文件安装）

`speech-hook.js` 按以下顺序定位 `engine/speak.ps1`：

1. `DSH_SPEAK_ENGINE` 环境变量覆盖；
2. 相对插件文件解析 `<包>/engine/speak.ps1`——同时覆盖仓库检出和
   `npm install` 后的 `node_modules/dsh-speak/`；
3. 旧的 `%USERPROFILE%\.dsh\hooks\speak.ps1`（文件安装的位置）。

因为引擎随 npm 包分发，用户只需 `dsh plugin --profile web add dsh-speak`
一条命令，无需额外拷贝。

### 发布步骤（维护者）

```powershell
npm login --registry=https://registry.npmjs.org   # 官方源，npm 强制要求 2FA
npm publish                                       # publishConfig.registry 已锁定官方源
# 后续每次发布前先在 package.json 里 bump "version"
```

> 中国区注意：如果你的全局 `.npmrc` 指向镜像（如 `registry.npmmirror.com`），
> `npm login`/`npm publish` 会打到镜像站——镜像**不接受发布**。本包的
> `publishConfig.registry` 已把发布锁定到官方源；登录时也要用官方源。

### 安装步骤（DSH 用户）

```powershell
dsh plugin --profile web add dsh-speak
# 然后在 ~/.dsh/profiles/web/cordis.patch.yml 注册：
#   - insert:
#       - id: speech-hook
#         name: 'dsh-speak'
# 重启 DSH web 应用
```

> 没装 pnpm？`dsh plugin` 内部转发给 pnpm；等价命令是
> `npm install --prefix "$env:USERPROFILE\.dsh\profiles\web" dsh-speak`
> （效果相同：包进入 profile 的 dependencies 与 node_modules）。
> 改 `cordis.patch.yml` 时 patch 监视器会热更新插件树——已验证：插件以 npm 包内
> 引擎路径重新 apply，注册切换本身无需重启。
