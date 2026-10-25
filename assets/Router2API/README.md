# Router2API

.NET 10 模型路由宿主：把不同提供方的模型统一成 OpenAI 兼容接口，自带 Vue 3 管理后台。本源分发的是**飞牛 fnOS 原生包**（`.fpk`，非 Docker）。

- 构建方式：本源（FFFFFFFFNNN）的 GitHub Actions 从上游源码构建，amd64 + arm64 原生双架构
- 安装类型：系统空间（root），服务端口 5242（固定）
- 依赖：无需额外依赖——包内是 .NET 自包含运行时，并内置 redis-server（仅监听 127.0.0.1）
- 数据目录：应用 var 目录（如 `/vol1/@appdata/Router2API`）——升级不丢配置、密钥、数据库与插件
- 安装完成后访问 `http://<NAS地址>:5242/` 进入管理后台

## 怎么拿到下游 API Key

管理后台的「配置中心 → 替换 API Key」那个输入框只用于**替换**，已存在的 Key 不会回显明文（上游设计如此，那里只显示「当前状态：已配置」）。

**方式一（最简单，不需要 root）：**

应用启动时会把 Key 另存一份可读副本，用文件管理器或任意账号直接查看即可：

```
/vol1/@appdata/Router2API/API-KEY.txt
```

**方式二（命令行，也不需要 root）：**

```sh
/var/apps/Router2API/cmd/show-api-key          # 带说明的完整输出
/var/apps/Router2API/cmd/show-api-key --quiet  # 只输出 Key，便于管道复制
/var/apps/Router2API/cmd/show-api-key --json   # JSON 输出，便于脚本消费
```

脚本优先读 `Config/Config.json`（拿到的是最新值），读不到时自动回退到 `API-KEY.txt`。

**方式三（已登录管理后台时，在浏览器控制台执行）：**

```js
fetch('/api/admin/api-key/raw').then(r => r.json()).then(console.log)
```

拿到后填到客户端的 API Key 处，或作为 `Authorization: Bearer <key>` 请求头使用。

> Key 的权威来源是 `/vol1/@appdata/Router2API/Config/Config.json` 的 `Auth.ApiKey.Key`，该文件权限 600、属主为应用用户，普通账号读不到——这正是 `API-KEY.txt` 存在的意义。
> 在管理后台**改过** Key 之后，重启一次应用，`API-KEY.txt` 会自动更新。

## 关于本源

本仓库自行从上游源码构建并发布 fpk（tag：`Router2API-<版本>`），索引里的下载地址指向本源，不依赖任何第三方 fork。
应用中心显示的**作者为最上游项目作者**。

发布版本号在跟随上游的基础上保证**数字段单调递增**（例如上游 `2.0.9` 重发时为 `2.0.9.1`），这样飞牛应用中心才能正确提示更新。
