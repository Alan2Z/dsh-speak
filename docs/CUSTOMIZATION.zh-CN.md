# CUSTOMIZATION.zh-CN.md — dsh-speak 自定义指南

（English: docs/CUSTOMIZATION.md）

dsh-speak 刻意保持小巧，但提供三层自定义：**配置**（不改代码）、**引擎覆盖**（复制后改）、
**扩展**（新后端 / 新适配器）。以下所有方式都不会被 `npm update` 覆盖。

---

## 一、配置（推荐）

在 profile patch 的 `config` 块里设置——`dsh --dump-config` 可见、按 profile 隔离、
npm 更新永不覆盖：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: speech-hook
      name: 'dsh-speak'
      config:
        throttleMs: 1500        # 播报前的合并延迟（毫秒）
        engine: ''              # 引擎路径覆盖；'' = 自动解析
        announceApprovals: true # 播报审批请求
        announceQuestions: true # 播报 ask_user_question 提问内容
        stripApprovalPrefix: true  # 剥离审批原因里的 "escalate sandbox to ...: " 前缀
        longTextMode: message   # message | heading（念最大字号 markdown 标题）
        maxChars: 300           # 引擎单次朗读字数上限
        volume: 50              # 仅 Windows
        rate: 0                 # 0 = 引擎默认（Windows SAPI 刻度 / macOS wpm）
```

### 选项说明

| 选项 | 默认值 | 效果 |
| ---- | ------ | ---- |
| `throttleMs` | `1500` | 回复文本等待多久才播报（合并同一回复的多步消息） |
| `engine` | `''` | 显式引擎脚本路径；`''` 自动解析：包内 `engine/<平台>` → `~/.dsh/hooks/<平台>` |
| `announceApprovals` | `true` | 播报 `approval/asked` 事件（审批原因，或固定提示语） |
| `announceQuestions` | `true` | 把 `ask_user_question` 调用播报成"问题（单选/多选），选项：…" |
| `stripApprovalPrefix` | `true` | 剥离审批原因里的固定英文模板前缀（`escalate sandbox to danger-full-access: `），保留中文说明 |
| `longTextMode` | `message` | `message` = 超长念固定提示语；`heading` = 改念最大字号 markdown 标题（规则见下） |
| `maxChars` | `300` | 引擎单次朗读上限（SAPI/NVSAPIAdapter 超过约 375-470 字会静默失败） |
| `volume` | `50` | 仅 Windows（0-100）；macOS 音量跟随系统 |
| `rate` | `0` | `0` = 引擎默认（Windows SAPI 刻度如 1；macOS words-per-minute 如 175） |

### 超长文本模式

清洗后文本超过 `maxChars` 时：

- **`message`**（默认）：念 `LongTextMessage`（`本次播报内容较长，请自行阅读。`，
  可用引擎参数 `-LongTextMessage` / `-l` 覆盖）。
- **`heading`**：在原始文本里挑**最大字号**的 markdown 标题——`#` 数量最少者优先，
  并列取第一个；没有标题行则取第一个非空行。选中的候选仍会清洗并受 `maxChars`
  上限约束，若其本身仍超长则回退提示语。

---

## 二、引擎覆盖（复制后改）

想改"实际念出来的内容"（音色选择、清洗规则、默认参数），把引擎复制出包并指向你的副本：

```powershell
# Windows
Copy-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-speak\engine\speak.ps1" "$env:USERPROFILE\.dsh\hooks\my-speak.ps1"
# macOS
cp ~/.dsh/profiles/web/node_modules/dsh-speak/engine/speak.sh ~/.dsh/hooks/my-speak.sh
```

然后在 config 里设引擎路径：

```yaml
config:
  engine: 'C:/Users/<你>/.dsh/hooks/my-speak.ps1'   # macOS 用 ~/.dsh/hooks/my-speak.sh
```

`npm update` 永远不会碰你的副本。

---

## 三、扩展

- **新引擎后端**：引擎是唯一接缝。新后端（`speak-edge.ps1` 封装 edge-tts、
  `speak-piper.ps1` 接本地模型……）保持同样的参数契约与清洗管线——适配层不用改。
  见 [DESIGN.zh-CN.md §7](DESIGN.zh-CN.md#7-扩展)。
- **新 harness 适配层**：拿到最终回复文本 → 调引擎。DSH（事件流）、Claude Code
  （Stop hook）、Agent 自调用（`speech-summary.ps1`）是三种参考范式。
- **发布自己的变体**：fork 本仓库、按需调整、发布自己的 npm 包——`dsh.bundle`
  manifest 已让它天然支持 `dsh plugin add` 安装。
