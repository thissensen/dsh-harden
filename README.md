# dsh-harden

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-harden"><img src="https://img.shields.io/npm/v/dsh-harden?logo=npm&logoColor=white&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/thissensen/dsh-harden/actions/workflows/ci.yml"><img src="https://github.com/thissensen/dsh-harden/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/thissensen/dsh-harden/releases"><img src="https://img.shields.io/github/v/release/thissensen/dsh-harden?color=blue&logo=github" alt="Release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/thissensen/dsh-harden?color=3da639" alt="license"></a>
</p>

<p align="center">
  <b>DSH 运行时看护层 —— 让任何一次停止都有明确原因</b>
</p>

<p align="center">
  <a href="./README.en.md">English</a> ·
  <a href="https://github.com/thissensen/dsh-harden">GitHub</a>
</p>

## 插件用途

1. API由于特殊原因导致的调用失败后，可续接并自动重试

2. 工具调用失败被吞导致会话莫名结束（需在设置页填「失败提示前缀」，否则本条不生效）

3. 第三方API经常出现的：只输出思考直接中断，插件会自动重试

4. 创建对接pwsh的后台job工具，解决只使用gitbash无法创建超120秒的后台任务

5. 一键修复异常会话日志

6. 上下文自动压缩 —— 会话涨到阈值自动把老历史压成摘要，界面沿用平台自带提示；压缩范围另有下拉框三档可选（全部压缩 / 仅主代理 / 仅子代理，默认全部压缩）

7. 子代理通知聚合 —— 多个子代理并行结束时不再逐个唤醒主代理：中间通知先压住，全部结束后合并成一条统一送达（默认关闭，可在设置页打开）

8. 子代理会话异常自动修复 —— 解决子代理运行过程中莫名的会话无法打开情况；平台写出的重试事件不合规时，在落盘前先修正，修正发生时回合尾部显示一行浅色提示（**常驻开启，没有开关**）

## 问题截图

会话日志被写坏后，平台会直接报错、整段历史再也打不开；插件在设置页提供一键扫描并修复：

<p align="center">
  <img src="./assets/fix-session-corrupt.png" width="90%" alt="历史加载失败：stored session is corrupt">
</p>

工具调用失败被吞时，插件自动提示模型重新发起，回合不会莫名结束：

<p align="center">
  <img src="./assets/fix-tool-call-retry.png" width="90%" alt="工具调用失败，已提示模型重新发起">
</p>

模型只输出思考、没有正文就收尾时，插件自动提示模型补充正文，回合不会莫名结束：

<p align="center">
  <img src="./assets/fix-empty-turn.png" width="90%" alt="回合没有答复就收尾，已提示模型补充正文">
</p>

## 插件截图

<p align="center">
  <img src="./assets/settings-zh-light.png" width="45%" alt="设置页（中文 · 浅色）">
  <img src="./assets/settings-zh-dark.png" width="45%" alt="设置页（中文 · 深色）">
</p>

## 安装

三条路选一条，装完还必须把插件注册到 profile —— 这一步是必须的（见下一节）。

### 1. 从 npm 安装

```bash
npm install dsh-harden
```

### 2. 从 GitHub Releases 下载

到 [Releases](https://github.com/thissensen/dsh-harden/releases) 下载 `dsh-harden-<版本>.tgz`：

```bash
dsh plugin --profile web add file:<tgz 文件的绝对路径>
```

### 3. 从源码构建

```bash
git clone https://github.com/thissensen/dsh-harden.git
cd dsh-harden
pnpm install
node scripts/link-deps.mjs    # 把宿主包链进本项目的 node_modules
pnpm build                     # tsc（host）+ vite（client）
```

首次构建必须在启动 DSH 之前完成（client 壳受启动快照约束）。

## 注册到 profile

上面三条路只是把文件放到位置，还得把 `dsh-harden` 注册进 profile，DSH 启动时才会加载它。

**桌面端**：手动改 `~/.dsh/profiles/desktop/package.json` 的两个地方：

1. 在 `dependencies` 里加 `"dsh-harden": "link:<克隆目录>/dsh-harden"`（从 npm 装的用版本范围）；
2. 在 `dsh.profile.bundles` 数组里加 `"dsh-harden"`。

然后在该目录跑 `pnpm install`，并**重启桌面端**（client 壳受启动快照约束）。

**Web 端**：一条 CLI 命令

```bash
dsh plugin --profile web add link:<克隆目录的绝对路径>
```

## 设置页

设置页在「DSH优化」分区下，共 **八张卡**：

| 卡片 | 说明 |
|---|---|
| **工具调用失败续跑** | 开关。工具调用失败被吞、框架仍把回合当作正常结束时，注入一条提示让模型重新发起。另有 **失败提示前缀**：只填平台警告的固定开头，整段匹配开头（不拆行）、区分大小写。**默认空 —— 留空则规则 H1 不生效。** 例：`⚠ Could not execute tool`。 |
| **回合无正文收尾** | 开关。最后一步只有思考、既没有回复也没有工具调用的回合，会被拉回再走一步。 |
| **网络请求中断续跑** | 开关 + **网络重试次数**（官方重试耗尽后最多再补几次，0–99；填 0 表示不兜底）+ **触发重试的失败特征**（错误码 `SERVER` / `RATE_LIMIT` / `TIMEOUT` / `TRANSPORT` 与 HTTP 状态码 `502` / `429`；留空表示不重试任何失败）。 |
| **上下文自动压缩** | 开关 + **压缩范围**（下拉框：全部压缩 / 仅主代理 / 仅子代理，默认全部压缩）+ **触发阈值**（如 `200K` / `1M` / `100000`；插件默认为 `200K`）+ **摘要指令**（生成摘要时发给模型的指令）。会话超过阈值后，较早的一段历史被浓缩成摘要，并沿用平台自带的「上下文已压缩」提示。 |
| **后台任务工具** | 开关。开启后模型可以用 `job_background` 起后台命令，再用 `job_list` / `job_output` / `job_kill` 管理；关闭后该工具消失。 |
| **子代理通知聚合** | 开关，**默认关闭**。多个子代理并行结束时，中间通知先压住，全部结束后合并成一条统一送达，不再逐个唤醒模型。 |
| **子代理会话异常自动修复** | **没有开关，常驻开启。** 平台即将写入不合规的重试事件时，插件在落盘前先修正，会话因此不会变得打不开；修正发生时回合尾部显示一行浅色提示。 |
| **修复损坏会话** | 扫描按钮。扫描全部会话日志并修复已知的损坏形态，让打不开的历史重新可用。 |

> ⚠️ **最要紧的一条**：**「失败提示前缀」默认为空，装完不填，规则 H1 就不生效。** 请打开设置页，把你的平台警告原文的固定开头粘进去（例：`⚠ Could not execute tool`）。

> 设置页截图取自旧版本面板，与当前卡片文案不完全一致，以实际界面为准。

## 开发

```bash
pnpm install
node scripts/link-deps.mjs    # 把宿主包链进本项目的 node_modules
pnpm build                     # tsc（host）+ vite（client）
pnpm typecheck                 # 只做类型检查
pnpm test                      # vitest，184 例
```

## 许可

[MIT](./LICENSE)
