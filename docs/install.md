# 安装

## 环境要求

- **DSH（DeepSeek Harness）**：纯 Web 版（`dsh --profile web`）与桌面版（`dsh --profile desktop`）都行——桌面版是 Web 版加一层 Electron 壳，host 半边同一套代码，平台版本要求也一样。
- **版本**：需要 **DSH `0.2.2-rc.1` 及以上**（`engines.dsh` 与 `peerDependencies` 里的平台包**同串**写 `>=0.2.2-rc.1`）。这个下界写的是**全功能最低版本**：呈现方式与工具面走的是 0.2.2 的平台契约——呈现方式由预设里挂的那条工具执行器行决定，工具声明在 agent 创建窗口收窄。
- **装在达不到下界的平台上会怎样**：启动门禁**整份跳过**这个 bundle（日志里是 `skipping profile bundle "dsh-agent-studio"`），插件市场也会拦住这次更新——没有「装了半残」的中间态。升级时**先升平台、再升插件**：顺序反了，插件会在旧平台上被跳过，看起来像「消失」，不是崩溃。
- 本插件不挑操作系统，Windows / macOS / Linux 都能用。

## 三条安装路线

按你手头的条件挑一条：有网络就用 npm，内网或离线用 GitHub Release 的安装包，想改代码就走源码。

### 从 npm 安装

```sh
dsh plugin --profile web add dsh-agent-studio
```

桌面版把 `--profile web` 换成 `--profile desktop`。

### 从 GitHub Release 安装

到 [Releases](https://github.com/thissensen/dsh-agent-studio/releases) 下载 `dsh-agent-studio-<版本>.tgz`——它就是 npm 上那份包，`lib/` 与 `client/` 的构建产物都在里面，不用自己构建：

```sh
dsh plugin --profile web add "./dsh-agent-studio-0.2.1.tgz"
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

卸载即恢复原状。所有配置存在插件自己的数据里，宿主既有的预设定义一个都不改；移除后平台预设的装配回到从没装过的样子。
