# DSH.md — dsh-speak 在 macOS 上的安装与使用指南

> 本文档同时是给 **DSH agent** 看的执行说明书：如果你（agent）被要求"按 DSH.md 安装 dsh-speak"，
> 请按下面步骤逐步执行；涉及写 `~/.dsh`（工作区外）或安装软件时，提醒用户审批。

## 这是什么

dsh-speak 是一个让 DSH 在 Agent 回复完成后**语音播报最终回复**的插件。
macOS 上引擎使用系统自带的 `say` 命令（`engine/speak.sh`），无需安装任何额外软件。

## 目标环境

- macOS（Apple Silicon / Intel 均可），建议 macOS 14+
- 已安装 DSH（`dsh` 命令可用）
- 开发环境齐全（git / npm 可用）

## 一、环境确认

在终端执行：

```bash
dsh --version            # DSH 可用？
git --version            # git 可用？
npm --version            # npm 可用？
say -v '?' | grep zh_CN  # 有中文语音（Eddy/Flo/Tingting 等）
```

## 二、安装插件（推荐 npm 方式）

```bash
# 没有 pnpm 也能装（dsh plugin 依赖 pnpm，npm 直装效果相同）
npm install --prefix "$HOME/.dsh/profiles/web" dsh-speak
```

> 备选：若环境里有 pnpm，也可用官方命令
> `dsh plugin --profile web add dsh-speak`。
>
> 备选（文件方式，不依赖 npm）：
> ```bash
> git clone https://github.com/Alan2Z/dsh-speak.git /tmp/dsh-speak
> mkdir -p "$HOME/.dsh/hooks" "$HOME/.dsh/profiles/web/plugins"
> cp /tmp/dsh-speak/engine/speak.sh "$HOME/.dsh/hooks/"
> cp /tmp/dsh-speak/adapters/dsh/speech-hook.js "$HOME/.dsh/profiles/web/plugins/"
> ```

## 三、注册插件

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在文件末尾追加（npm 方式用裸包名）：

```yaml
# dsh-speak: 自动语音播报（macOS 版，引擎用系统 say）
- insert:
    - id: speech-hook
      name: 'dsh-speak'
```

> 文件方式则把 `name` 换成文件 URL（`<用户名>` 换成实际用户名）：
> `name: 'file:///Users/<用户名>/.dsh/profiles/web/plugins/speech-hook.js'`

## 四、先单独测试引擎（不依赖 DSH，可先验证出声）

```bash
# 下载最新引擎脚本（如果没走 npm/文件安装，直接测这个）
curl -o ~/speak.sh https://raw.githubusercontent.com/Alan2Z/dsh-speak/main/engine/speak.sh
chmod +x ~/speak.sh

~/speak.sh -t "你好，Mac 版语音播报测试"      # 默认：跟随系统语音
~/speak.sh -t "指定音色测试" -v Tingting      # 指定音色
~/speak.sh -t "语速快一点" -r 250             # 语速（wpm，默认 175）
```

## 五、生效与验证

- `cordis.patch.yml` 的改动会被 DSH **热更新**（watchUserPatches），一般无需重启；
  不放心就重启 `dsh web`。
- 插件诊断日志：`/tmp/dsh-speech-hook.log`，加载成功会看到：
  `plugin apply 执行（加载成功）; engine= .../engine/speak.sh`
- 验收：让 agent 输出一条**纯文字回复**（中间没有工具调用），确认电脑出声。

## 六、音色说明（macOS 特有，重要）

- **默认跟随系统语音**：新版 macOS 上即 系统设置 → Siri → 声音 里选的音色
  （"声音 1-4"，1/3 为男声，2/4 为女声）。
- **Siri 的"声音 1-4"无法用 `say -v` 按名选中**——它们不出现在 `say -v '?'`
  列表里，只能作为系统默认生效；想换 Siri 音色去系统设置改。
- 可显式指定的音色见 `say -v '?'`（中文常用：`Eddy` / `Flo` / `Tingting`）。
- `say` 没有音量参数——音量跟随系统输出音量。

## 七、排障

| 现象 | 处理 |
| ---- | ---- |
| 中文被吞、只剩英文 | 确认 speak.sh 是最新版（已内置 UTF-8 locale 修复）；重下脚本 |
| 完全不发声 | 先测 `say "测试"`；检查系统音量 / 输出设备 |
| 插件没生效 | 看 `/tmp/dsh-speech-hook.log`；检查 cordis.patch.yml 语法与插件路径 |
| 引擎路径不对 | 插件按顺序找：`DSH_SPEAK_ENGINE` → 包内 `engine/speak.sh` → `~/.dsh/hooks/speak.sh` |

## 八、可调参数速查

| 参数 | 默认 | 说明 |
| ---- | ---- | ---- |
| `-r` | 175 | 语速（words per minute） |
| `-m` | 300 | 超过此字数改念提示语（say 对超长输入不稳） |
| `-l` | 本次播报内容较长，请自行阅读。 | 超长提示语 |
| `-v` | （跟随系统） | 指定音色名 |

插件环境变量：`DSH_SPEAK_ENGINE`（引擎路径）、`DSH_SPEAK_THROTTLE_MS`（播报合并延迟，默认 1500）。
想调音量/语速/字数上限，直接跟 agent 说，让它改参数即可。

## 九、回滚

```bash
# 移除注册（删除 cordis.patch.yml 里的 speech-hook 条目）后：
npm uninstall --prefix "$HOME/.dsh/profiles/web" dsh-speak
```
