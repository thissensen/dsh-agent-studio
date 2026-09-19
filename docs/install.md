# 安装

## 环境要求

- **DSH（DeepSeek Harness）**：纯 Web 版（`dsh --profile web`）与桌面版都支持。桌面版就是 Web 版加一层 Electron 壳，两边共用同一套 host 逻辑。
- 本插件不挑操作系统，Windows / macOS / Linux 都能用。

## 三条安装路线

按你手头的条件挑一条：有网络就用 npm，内网或离线用 GitHub Release 的安装包，想改代码就走源码。**首发版本 v0.1.0 定在 2026-09-22**，npm 与 Release 里的安装包同一天就位。

### 从 npm 安装（2026-09-22 发布）

按你用的 profile 选一条：

::: code-group

```sh [Web 版]
dsh plugin --profile web add dsh-agent-studio
```

```sh [桌面版]
dsh plugin --profile desktop add dsh-agent-studio
```

:::

### 从 GitHub Release 安装（2026-09-22 发布）

到 [Releases](https://github.com/thissensen/dsh-agent-studio/releases) 下载 `dsh-agent-studio-<版本>.tgz`——它就是 npm 上那份包，`lib/` 与 `client/` 的构建产物都在里面，不用自己构建：

```sh
dsh plugin --profile web add "./dsh-agent-studio-0.1.0.tgz"
```

包放在哪个目录都行，把路径写对即可（`./` 开头或绝对路径），文件名里的版本号换成你实际下载的那个。**离线、内网环境走这条。**

### 从源码安装

适合想改代码的人。先取源码：

```sh
git clone https://github.com/thissensen/dsh-agent-studio.git dsh-agent-studio
cd dsh-agent-studio
```

不想用 `git` 的话，把 Release 页的源码压缩包（`Source code (zip)`）解压出来代替 `git clone`，后续步骤一样。

再装依赖并挂载：

```sh
pnpm install                      # 只装 devDependencies；peer 是宿主包，不走 registry
node scripts/link-deps.mjs web    # 把宿主的 @deepseek-ai/* 链进本项目的 node_modules
dsh plugin --profile web add "link:<本目录的绝对路径>"
```

- `link:` 装法下改 `lib/` 立即生效；改面板（`client/parts/panel.js`）刷新页面就行，不用重启。
- 改 `package.json` 的入口类字段（`main` / `exports` / `dsh.*`）后必须重启。

三条路装完都**重启一次 DSH**，在 **设置 → Agent 中心** 看到面板就成了。

## 更新

- **npm 装法**：重新执行一次安装命令（`dsh plugin --profile <profile> add dsh-agent-studio`），或在你的 profile 里用惯用的更新方式。
- **Release 装法**：下载新版本的 `.tgz`，再 `add` 一次即可覆盖。
- **源码装法**：`git pull` 后重新 `pnpm build`。

## 卸载

```sh
dsh plugin --profile web remove dsh-agent-studio
```

卸载即恢复原状。本插件不写、不删、不改宿主的任何预设文件，所有配置存在插件自己的数据里；移除后平台预设的装配回到从没装过的样子。
