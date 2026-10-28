# DSH · 飞牛 fnOS 打包工具（fpk）

把上游 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）打成飞牛 fnOS 可安装的 **原生 fpk**：`amd64` / `arm64` 双架构、飞牛桌面一键打开、不依赖 Docker。

```bash
./build.sh                          # 打包上游最新 Release，本机架构
./build.sh --version 0.2.1-rc.4     # 指定版本
./build.sh --arch arm64             # 目标 arm64
./build.sh --from ~/deepseek-harness # 用本地源码 checkout（已 pnpm build）打包
```

产物：`dist/DSH_v<版本>_<架构>.fpk`

安装：飞牛应用中心 → 手动安装 → 上传 fpk（已安装则覆盖升级）。
依赖：应用中心需已安装 **nodejs_v24** 运行时（包内不带 Node，省 100+MB）。
访问：飞牛桌面点 DSH 卡片，或 `http://<NAS地址>:3080`。

---

## 1. 组成

| 路径 | 作用 |
|------|------|
| `build.sh` | 入口：解析版本 → 备好上游产物 → 组装 → `fnpack build` → 重命名产物 |
| `scripts/assemble.sh` | 把 DSH 装进 fnOS 应用壳，做瘦身、软链清理、装包校验 |
| `appshell/` | fnOS 应用壳：`manifest`、生命周期脚本 `cmd/`、`config/`、`wizard/`、`ui/`、图标 |
| `runtime/runner.js` | 反向代理运行器（只依赖 Node 内置模块），见第 3 节 |
| `runtime/xdg-open` | `xdg-open` 垫片：把配置文件导出到共享目录（NAS 无桌面环境） |

## 2. 上游产物从哪来

默认走 **npm registry**：`@deepseek-ai/dsh` 就是上游仓库 `apps/cli` 的发布产物，版本与上游 Release tag（`dsh-v<版本>`）一一对应。这样本机（2 核）不必 `pnpm install && pnpm run build` 整个 monorepo。

版本解析优先级：

1. `--version <版本>`
2. `--tag <latest|next|alpha>`（npm dist-tag）
3. 上游 GitHub 最新非草稿 Release 的 `dsh-v*` tag
4. npm `next` → npm `latest`

`--from <dir>` 走源码模式：在该 checkout 里 `pnpm --filter @deepseek-ai/dsh pack` 出 tgz 再装，用于跟进尚未发布到 npm 的提交（要求该 checkout 已 `pnpm install && pnpm run build`）。

## 3. 为什么需要一个 runner（而不是直接跑 `dsh web`）

`dsh web` 的 `--host` **只接受一个具体的本机地址，不接受 `0.0.0.0`**（会以用法错误退出）。NAS 的 IP 可能是 DHCP 分配的，写死某个 IP 不可行。因此：

```
浏览器 → 0.0.0.0:3080 (runner)  →  127.0.0.1:3081 (dsh web)
```

`runtime/runner.js` 除了转发，还负责几件上游没提供、但局域网 HTTP 场景必需的事：

- **认证 cookie**：优先用 `dsh web` 启动时打印的 `?token=` 走官方通道兑换会话 cookie；拿不到时回退为按 `client-connection/browser-session` secret 自签。浏览器无需登录。
- **Origin/Referer 剥离**：dsh 校验来源必须与自身 authority 一致，代理端口不匹配会被拒。
- **`__DSH_TRANSPORT__.ownsHost` 与 `crypto.randomUUID` 注入**：非回环 HTTP 属于非安全上下文，不注入则设置镜像降级为 memory 模式（界面报「settings are unavailable in this browser」）、`randomUUID` 缺失。
- **WebSocket 透传**、**401 自动重新兑换**、**子进程崩溃联动退出**。

## 4. 应用壳要点（踩过的坑）

| 项 | 说明 |
|----|------|
| `install_dep_apps = nodejs_v24` | Node 由应用中心提供（`/var/apps/nodejs_v24/target/bin/node`），包内不带 |
| `DSH_HOME` 必须显式设置 | dsh 的 home 解析优先 `$DSH_HOME`，而 `os.homedir()` 取 passwd 家目录（不认 `$HOME`），不设会把配置/凭据写到 `/home/dsh/.dsh` |
| `XDG_DOCUMENTS_DIR` | 不设则 `xdg-user-dir DOCUMENTS` 回退到 `$HOME`，dsh 判定文档目录不可用 → 「无法创建默认工作区」 |
| `SHELL=/bin/bash` | 应用用户登录 shell 是 `nologin`，不设则侧边栏终端直接退出 |
| 端口 | `service_port = 3080`，`ui/config` 里的 `port` 必须一致；runner 用 3081 作内部端口 |
| `app/ui/` 必须存在 | fnpack 打 `app.tgz` 时缺 `app/ui` 会报 `stat app/ui: no such file or directory` |
| `node_modules/.bin` 软链 | 不能实体化（相对 require 会失效），也不能留软链（安装器报 10234「设置目录权限失败」）→ 生成 node 转发脚本 |
| 数据目录 | `TRIM_DATA_SHARE_PATHS` 优先（`/vol1/@appshare/dsh`，文件管理/SMB 可见），回退 `TRIM_PKGVAR` |

## 5. 架构说明

npm 只按**本机架构**装原生模块（koffi、node-pty 等）。给别的架构打包时脚本会传 `--os=linux --cpu=<arch>` 让 npm 选预编译产物，但含本地编译的包仍可能装成本机架构；`assemble.sh` 会校验 `.node` 产物架构，混入错误架构直接失败。稳妥做法：在目标架构的机器 / 对应架构容器 / CI runner 上执行。

## 6. 校验

`assemble.sh` 在打包前做这几项硬校验，任一不过就中止（避免「装得上、点开就崩」）：

1. `@deepseek-ai/dsh/lib/bin.js` 存在
2. `pnpm` 随包且能执行（dsh 插件安装器硬依赖 PATH 里的 pnpm）
3. dsh `lib/` 里**顶层静态 import** 的每个包都能被 `import.meta.resolve` 解析（缺了先补装，补不上失败）
4. 原生模块是 `linux-<目标架构>`，且未混入另一架构
5. 包内**零软链**

## 7. 卸载与数据

卸载向导提供三档：保留全部数据（默认）/ 只删会话与凭据（`.dsh`）/ 删除全部应用数据。飞牛默认保留数据，只有应用自己显式清理才会删，故 `cmd/uninstall_callback` 自己做这件事，并且只删 `/vol*/@appshare/dsh`、`/vol*/@appdata/dsh` 这类应用自己的路径。
