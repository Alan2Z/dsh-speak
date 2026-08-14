# dsh-speak 🔊 — 为 AI 编程 harness 提供语音播报

让 Agent 在长任务完成时**开口告诉你**——不用再盯着屏幕等。

dsh-speak 通过 Windows 语音合成把 Agent 的最终回复朗读出来，优先使用自然语音
（Windows 11 内置，或 Windows 10 上经 [NaturalVoiceSAPIAdapter] 注册，如晓晓），
没有时优雅回退到系统自带中文语音。本项目为
[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 而生，但结构上
任何 harness 都能接入。

> **项目定位**：本项目只是为了给想让 harness 开口说话的用户提供一种**已经验证过的方案**；
> 没有意外的话，后续不会再更新。

```
harness 事件（DSH 会话事件 / Claude Code Stop hook / 任意方式）
      │
      ▼  adapters/…  （harness 专属触发器：过滤、节流、取消）
      ▼  engine/speak.ps1  （与 harness 无关：清洗文本 → Windows SAPI5）
      ▼  🔊 你听到最终回复
```

## 特性

- **全自动**：DSH web 插件监听会话事件流，自动播报最终回复
  （跳过 reasoning/工具调用旁白，合并同一回复的多步消息）。
- **尽力而为**：绝不抛错、绝不阻塞 harness、绝不破坏会话。
- **自然语音**：优先使用自然语音——Windows 11 内置语音包，或 Windows 10 上经
  NaturalVoiceSAPIAdapter 注册的语音（如晓晓），回退到任意已安装语音。
- **健壮的文本清洗**：去掉会让 SAPI `Speak()` 静默失败的 markdown/URL/emoji，
  并守卫适配器单次朗读的字数上限。
- **引擎可移植**：任意进程一行即可朗读：
  `powershell -File speak.ps1 -Text "你好"`。

## 前置条件

- Windows 10 或 11，任意较新的 PowerShell。
- 自然语音：
  - **Windows 11**：系统已内置自然语音包，无需额外安装——在
    *设置 → 辅助功能 → 讲述人* 或 *设置 → 时间和语言 → 语音* 中启用/切换即可。
  - **Windows 10**：需要安装
    [NaturalVoiceSAPIAdapter](https://github.com/gexgd0419/NaturalVoiceSAPIAdapter)，
    并用它的 VoiceDownloader 手动下载你需要的中文或其他语言的自然语音包。
- 没有自然语音时，引擎回退到系统自带语音（如 Huihui）。

## 快速开始 — DSH

### 方式 A — npm 插件（推荐）

```powershell
# 1. 把插件装进你的 web profile（会写入 ~/.dsh/profiles/web/package.json 的 dependencies）
dsh plugin --profile web add dsh-speak

# 2. 在 ~/.dsh/profiles/web/cordis.patch.yml 里注册（npm 包直接用包名，无需 file:/// URL）：
#    - insert:
#        - id: speech-hook
#          name: 'dsh-speak'

# 3. 重启 DSH web 应用 — 之后回复会被自动播报
```

引擎随包分发（`node_modules/dsh-speak/engine/`），无需额外拷贝。

### 方式 B — 文件安装（不需要 npm）

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

## 快速开始 — Claude Code

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

## 快速开始 — 其他任何 harness

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

引擎参数（详见 [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md#5-配置参考)）：

```powershell
speak.ps1 -Text "…" -Volume 50 -Rate 1 -MaxChars 300 -LongTextMessage "本次播报内容较长，请自行阅读。"
```

DSH 插件环境变量：

| 变量 | 默认值 | 含义 |
| --- | ------- | ---- |
| `DSH_SPEAK_ENGINE` | `%USERPROFILE%\.dsh\hooks\speak.ps1` | 引擎路径 |
| `DSH_SPEAK_THROTTLE_MS` | `1500` | 播报前的合并延迟（毫秒） |

## 排障

| 现象 | 原因 | 解决 |
| ---- | ---- | ---- |
| 完全没有声音、无报错 | 未启用/安装自然语音 | Win11：在 设置 → 讲述人/语音 中启用自然语音；Win10：安装 NaturalVoiceSAPIAdapter 并下载语音包。直接测 `speak.ps1` |
| 长回复从不播报 | 适配器单次 `Speak` 有字数上限 | 已默认在 300 字处守卫——必要时调低 `-MaxChars` |
| 含大量 emoji 的文本静默 | SAPI 遇到 emoji 会静默失败 | 引擎已自动剥离 |
| 插件加载失败 | 插件名用了 Windows 原始路径 | 改用 `file:///C:/…` URL 形式（安装脚本会自动处理） |

插件诊断日志：`%TEMP%\dsh-speech-hook.log`

## 仓库结构

```
engine/                  与 harness 无关的语音引擎（PowerShell + SAPI5）
  speak.ps1              清洗 + 朗读（适配层唯一需要打交道的接口）
  speech-prompt.ps1      阻塞式短提示播报
  speech-summary.ps1     阻塞式回复总结播报
adapters/
  dsh/                   DSH web 插件 + 一键安装脚本
    speech-hook.js       会话事件触发器（节流 + 工具调用取消）
    install.ps1          拷贝 + 注册 + 备份
  claude-code/
    stop-hook.ps1        Claude Code Stop hook 触发器
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
