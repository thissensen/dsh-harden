# dsh-harden

<p align="center">
  <b>DSH 运行时看护层 —— 让任何一次停止都有明确原因</b>
</p>

<p align="center">
  <a href="./README.en.md">English</a> ·
  <a href="https://github.com/thissensen/dsh-harden">GitHub</a>
</p>

## 插件用途

1. API由于特殊原因导致的调用失败后，可续接并自动重试

2. 工具调用失败被吞导致会话莫名结束

3. 第三方API经常出现的：只输出思考直接中断，插件会自动重试

4. 修复打开资源管理器无反应的BUG

5. 创建对接pwsh的后台job工具，解决只使用gitbash无法创建超120秒的后台任务

## 插件截图

<p align="center">
  <img src="./assets/settings-zh-light.png" width="45%" alt="设置页（中文 · 浅色）">
  <img src="./assets/settings-zh-dark.png" width="45%" alt="设置页（中文 · 深色）">
</p>

## 安装

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

## 开发

```bash
pnpm install
node scripts/link-deps.mjs    # 把宿主包链进本项目的 node_modules
pnpm build                     # tsc（host）+ vite（client）
pnpm typecheck                 # 只做类型检查
pnpm test                      # vitest，50 例
```

## 许可

[MIT](./LICENSE)
