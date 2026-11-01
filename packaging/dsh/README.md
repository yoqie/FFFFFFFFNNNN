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
浏览器 ──► 3080 runner（唯一对外端口：HTTP + WebSocket 反向代理）
               │
               └──► 127.0.0.1:3081 dsh web（只绑回环，外部不可直连）
```

两个组件：

| 组件 | 作用 |
|------|------|
| `runner/runner.js` | 约 430 行。`0.0.0.0:3080` 上的反向代理：转发 HTTP 与 WebSocket；转发时把 `Host` 改写为回环 authority、剥掉 `Origin`/`Referer`、自签 dsh 会话 cookie 注入上游、并把上游的 `Set-Cookie` 从响应里删掉。同时负责拉起 `dsh web` 并在它退出时重启 |
| `appshell/cmd/main` | 生命周期：环境准备、写补丁层、起 runner、等就绪、看门狗、停止与状态 |

**为什么用「单入口反向代理」而不是让 dsh 直接对外**：dsh 的 `/api` 有一道 browser-trust 围栏（`dsh-client-connection` 的 `isTrustedApiRequest`）：Host 必须是回环 / 绑定地址 / `--trusted-host` 里的 authority，且请求一旦带 `Origin`，就必须与 `Host` 同源，否则 403。飞牛里浏览器地址是 `http://NAS:3080`，而 dsh 本体若自己对外就是另一个端口 —— 「页面在 3080、接口在 3081」的跨源请求会被围栏拒绝，表现就是**安装 / 卸载插件报 `origin not trusted`**。

由 runner 统一代理后：浏览器所有请求都是同源 3080；转发时 `Host` 改写为 `127.0.0.1:3081`、`Origin`/`Referer` 剥掉 —— 围栏按「回环 Host、无 Origin」放行，插件安装、插件市场、内置终端等所有 POST / WS 路径都不再受 Origin 限制。

**为什么不再需要启动令牌**：dsh 的浏览器会话 cookie 是用 `<DSH_HOME>/.credentials.yaml` 里 `client-connection/browser-session` 的 secret 做 HMAC-SHA256 签出来的（cookie 名 `dsh-auth-<hash(authority)>`，值 `v1.<payload>.<sig>`，payload 含 authority 与过期时间）。runner 确保该 secret 存在，然后给每个转发请求自签一个有效 cookie 注入上游，所以：

- 浏览器不用处理 `?token=`，飞牛桌面入口的静态 URL 直接可用；
- 浏览器也收不到 `Set-Cookie` —— dsh 自己那个 cookie 绑定的是 `127.0.0.1:3081` authority，塞给浏览器没有意义；
- **重启后不会 401**：cookie 由持久 secret 派生，不像一次性令牌那样每次启动都变，已打开的页面刷新即可；
- 若上游改了 cookie 格式（自签失效），runner 回退到官方「启动令牌换 cookie」，日志里会有提示。

**为什么 `cmd/main` 里还有看门狗**：dsh 本体由 runner 自己看护（退出一秒内重启），`cmd/main` 的看门狗只在 **runner 整个进程**意外死亡时兜底，两者不重复。

## 2. 目录

| 路径 | 说明 |
|------|------|
| `build.sh` | 入口：解析版本 → 组装 → `fnpack build` → 命名产物 |
| `scripts/assemble.sh` | 装 DSH、瘦身、软链清理、硬校验 |
| `appshell/` | fnOS 应用壳：`manifest`、`cmd/`、`config/`、`wizard/`、`ui/`、图标 |
| `runner/runner.js` | 反向代理 + dsh 进程看护 |
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
| 端口 | `service_port = 3080`（runner），dsh 用 3081；`ui/config` 的 `port` 必须与 manifest 一致。**对外只需要 3080** |
| 回环绑定 | dsh 用 `--host 127.0.0.1` 启在 3081，外部只能经 runner 进 —— 少一处暴露面，也顺带解决「NAS 换 IP 后要重启应用」（`--host` 不再需要具体局域网地址） |
| `app/ui/` 必须存在 | fnpack 打 `app.tgz` 时缺 `app/ui` 会在校验阶段失败 |
| pnpm 随包 | dsh 插件安装器直接 `execa("pnpm")`；用官方 `plugin-manager.pnpmCommand` 配置项指向包内 pnpm，**不改 PATH** |
| 补丁层用 `--patch` | `cmd/main` 每次启动在 `TRIM_PKGVAR` 写一个只读 overlay，不碰用户的 `cordis.patch.yml` |

## 5. 架构说明

npm 只按**本机架构**装原生模块（koffi、node-pty 等）。给别的架构打包时会传 `--os=linux --cpu=<arch>` 让 npm 选预编译产物，但含本地编译的包仍可能不对；`assemble.sh` 会校验 `.node` 产物架构，混入错误架构直接失败。稳妥做法：在目标架构的机器 / 对应架构容器 / CI runner 上执行。

## 6. 打包前的硬校验

任一不过就中止（避免「装得上、点开就崩」）：

1. `@deepseek-ai/dsh/lib/bin.js` 存在
2. `runner/runner.js` 存在
3. 随包 pnpm **能执行**（不是只看文件存在）
4. dsh `lib/` 里**顶层静态 import** 的每个包都能被 `import.meta.resolve` 解析（缺了先补装，补不上失败）
5. 原生模块是 `linux-<目标架构>`，且未混入另一架构；包内**零软链**（安装器遇到软链会报 10234「设置目录权限失败」）

## 7. 已知限制

- **「打开配置文件」按钮不可用**：该功能只在上游判定为回环访问时启用，NAS 场景属预期行为。
- **无桌面环境**：上游调 `xdg-open` 的入口在本包中不提供垫片，点了无反应，不影响主流程。
- **局域网内谁都能进**：runner 会把会话交给任何访问 3080 的请求方（本包没有账号体系）。**不要把这个端口暴露到公网**。
- **HTTP 明文**：局域网内是明文 HTTP，`navigator.clipboard` 之类的仅安全上下文 API 不可用（影响「复制会话标题」这类按钮）。
- **堆内存耗尽仍会中断会话**：dsh 因 `Reached heap limit` 退出时 runner 会立刻重启，但进行中的对话/任务会中断。如需推迟崩溃，可给 dsh 加 `NODE_OPTIONS=--max-old-space-size=<MB>`（本包未默认设置）。
- **NAS 本机可用 `127.0.0.1:3080`**：runner 监听 `0.0.0.0`；`localhost` 在部分系统会先解析到 `::1`，那里没人监听。
- **日志**：`/vol1/@appdata/dsh/dsh.log`，runner 与 dsh 的 stdout 都在里面。

## 8. 卸载与数据

卸载向导三档：保留全部数据（默认）/ 只删会话与凭据（`.dsh`）/ 删除全部应用数据。飞牛默认保留数据，只有应用自己显式清理才会删，故 `appshell/cmd/uninstall_callback` 自己清理，并且只删 `/vol*/@appshare/dsh`、`/vol*/@appdata/dsh` 这类应用自己的路径。
