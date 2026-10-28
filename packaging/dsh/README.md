# DSH · 飞牛 fnOS 打包

把上游 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打成飞牛 fnOS 原生 fpk：`amd64` / `arm64` 双架构，飞牛桌面一键打开，不依赖 Docker。

```bash
./build.sh                          # 打包上游最新 Release，本机架构
./build.sh --version 0.2.1-rc.4     # 指定版本
./build.sh --arch arm64             # 目标 arm64
./build.sh --from ~/deepseek-harness # 用本地源码 checkout（已 pnpm build）
```

产物：`dist/DSH_v<版本>_<架构>.fpk`
安装：飞牛应用中心 → 手动安装 → 上传 fpk（已安装则覆盖升级）。
依赖：应用中心需已安装 **nodejs_v24**（包内不带 Node，省 100MB+）。

---

## 1. 运行架构

```
浏览器 ──► 3080 gate ──302 + 启动令牌──► 3081 dsh web
                                          │
                     Set-Cookie: dsh-auth-… ◄┘  （dsh 自己签发）
```

三个组件，全部用上游官方能力，**没有反向代理**：

| 组件 | 作用 |
|------|------|
| `dsh web` | 上游本体。用官方 `--host` 直接绑定 NAS 局域网 IP（它拒绝 `0.0.0.0`），浏览器认证走它自己的「启动令牌 → 持久 cookie」流程 |
| `gate/gate.js` | 约 100 行。读取当前启动令牌，把浏览器 302 到 `http://<ip>:<port>/?token=…`。**不代理、不改请求头、不签发 cookie**；跳转后所有流量（含 WebSocket）直连 dsh |
| `appshell/cmd/main` | 生命周期：探测局域网 IP、起 dsh、抓令牌、起 gate、起看门狗、停止与状态 |

为什么需要 gate：dsh 的浏览器认证靠**每次启动都变**的一次性令牌换取 cookie，而飞牛桌面入口的 URL 是静态的，没法写死令牌。gate 只是把「静态入口」接上「动态令牌」，一步 302 之后就不再参与。

为什么需要看门狗：`dsh web` 是长时间运行的 Node 进程，实测会因堆内存耗尽（`Reached heap limit`，约 2 GB）退出。dsh 一退，gate 还在 3080 上把浏览器 302 到没人监听的 3081，用户看到的是「无法访问此网站」。看门狗每 10 秒检查一次 dsh 的 PID，进程不在就按同一套参数重启、重新抓令牌写进 `launch-token`（gate 每次请求都重读该文件，所以不必重启 gate）；连续失败会退避到最多 5 分钟一次。gate 在 302 之前也会探测 dsh 端口，探测不通就返回 503「DSH 正在重启」，不再把浏览器送到死端口。

令牌抓取只扫描**本次启动之后新增**的日志：日志是跨重启追加的，直接 grep 整个文件会在 dsh 打印新令牌之前命中上一轮的旧令牌，浏览器随后拿到 401。

## 2. 目录

| 路径 | 说明 |
|------|------|
| `build.sh` | 入口：解析版本 → 组装 → `fnpack build` → 命名产物 |
| `scripts/assemble.sh` | 装 DSH、瘦身、软链清理、硬校验 |
| `appshell/` | fnOS 应用壳：`manifest`、`cmd/`、`config/`、`wizard/`、`ui/`、图标 |
| `gate/gate.js` | 入口跳转器 |
| `CHANGELOG.md` | 打包层改动记录。`dsh-build` 发布时会整段拼进 Release 说明和飞牛应用中心的更新内容，跟上游版本无关的修复写这里 |

## 3. 上游产物从哪来

默认走 **npm registry**：`@deepseek-ai/dsh` 就是上游 `apps/cli` 的发布产物，版本与上游 `dsh-v*` Release 一一对应，因此不必在本机 `pnpm install && pnpm run build` 整个 monorepo。

版本解析优先级：`--version` → `--tag <latest|next|alpha>` → 上游最新非草稿 Release 的 `dsh-v*` tag → npm `next` → npm `latest`。

`--from <dir>` 走源码模式：在该 checkout 里 `pnpm --filter @deepseek-ai/dsh pack` 出 tgz 再装，用于跟进尚未发布到 npm 的提交（要求该 checkout 已 `pnpm install && pnpm run build`）。

## 4. 应用壳要点

| 项 | 说明 |
|----|------|
| `install_dep_apps = nodejs_v24` | Node 由应用中心提供（`/var/apps/nodejs_v24/target/bin/node`） |
| `DSH_HOME` 必须显式设置 | dsh 的 home 解析优先 `$DSH_HOME`，而 `os.homedir()` 取 passwd 家目录（不认 `$HOME`），不设会把配置/凭据写到 `/home/dsh/.dsh` |
| `XDG_DOCUMENTS_DIR` | 不设则 `xdg-user-dir DOCUMENTS` 回退到 `$HOME`，dsh 判定文档目录不可用 → 无法创建默认工作区 |
| `SHELL=/bin/bash` | 应用用户登录 shell 是 `nologin`，不设则内置终端直接退出 |
| `--trusted-host` | 必须传 `<ip>:<port>`，否则 Origin 校验会拒绝页面请求 |
| 端口 | `service_port = 3080`（gate），dsh 用 3081；`ui/config` 的 `port` 必须与 manifest 一致 |
| `app/ui/` 必须存在 | fnpack 打 `app.tgz` 时缺 `app/ui` 会在校验阶段失败 |
| pnpm 随包 | dsh 插件安装器直接 `execa("pnpm")`；用官方 `plugin-manager.pnpmCommand` 配置项指向包内 pnpm，**不改 PATH** |
| 补丁层用 `--patch` | `cmd/main` 每次启动写一个只读 overlay，不碰用户的 `cordis.patch.yml` |

## 5. 架构说明

npm 只按**本机架构**装原生模块（koffi、node-pty 等）。给别的架构打包时会传 `--os=linux --cpu=<arch>` 让 npm 选预编译产物，但含本地编译的包仍可能不对；`assemble.sh` 会校验 `.node` 产物架构，混入错误架构直接失败。稳妥做法：在目标架构的机器 / 对应架构容器 / CI runner 上执行。

## 6. 打包前的硬校验

任一不过就中止（避免「装得上、点开就崩」）：

1. `@deepseek-ai/dsh/lib/bin.js` 存在
2. `gate/gate.js` 存在
3. 随包 pnpm **能执行**（不是只看文件存在）
4. dsh `lib/` 里**顶层静态 import** 的每个包都能被 `import.meta.resolve` 解析（缺了先补装，补不上失败）
5. 原生模块是 `linux-<目标架构>`，且未混入另一架构；包内**零软链**（安装器遇到软链会报 10234「设置目录权限失败」）

## 7. 已知限制

- **IP 变化需重启应用**：`--host` 必须是具体地址，启动时探测默认路由的源地址；NAS 换了 IP 后重启应用即可。
- **「打开配置文件」按钮不可用**：该功能只在回环访问时启用（上游按 `location.hostname` 判断），NAS 场景属预期行为。
- **无桌面环境**：上游调 `xdg-open` 的入口在本包中不提供垫片，点了无反应，不影响主流程。
- **崩溃重启后需重新点桌面入口**：看门狗拉起新进程后令牌会变；已经打开的旧页面刷新可能仍是 401，重新点一次飞牛桌面图标即可拿到新 cookie。
- **堆内存耗尽仍会中断会话**：看门狗只能让服务自己恢复，进行中的对话/任务会中断。如需推迟崩溃，可给 dsh 加 `NODE_OPTIONS=--max-old-space-size=<MB>`（本包未默认设置）。

## 8. 卸载与数据

卸载向导三档：保留全部数据（默认）/ 只删会话与凭据（`.dsh`）/ 删除全部应用数据。飞牛默认保留数据，只有应用自己显式清理才会删，故 `cmd/uninstall_callback` 自己做，并且只删 `/vol*/@appshare/dsh`、`/vol*/@appdata/dsh` 这类应用自己的路径。
