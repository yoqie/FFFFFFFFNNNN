# Router2API

.NET 10 模型路由宿主：把不同提供方的模型统一成 OpenAI 兼容接口，自带 Vue 3 管理后台。本源分发的是**飞牛 fnOS 原生包**（`.fpk`，非 Docker）。

- 构建方式：本源（FFFFFFFFNNN）的 GitHub Actions 从上游源码构建，amd64 + arm64 原生双架构
- 安装类型：系统空间（root），服务端口 5242（固定）
- 依赖：无需额外依赖——包内是 .NET 自包含运行时，并内置 redis-server（仅监听 127.0.0.1）
- 数据目录：应用 var 目录（如 `/vol1/@appdata/Router2API`）——升级不丢配置、密钥、数据库与插件
- 安装完成后访问 `http://<NAS地址>:5242/` 进入管理后台

## 怎么拿到下游 API Key

管理后台的「配置中心 → 替换 API Key」那个输入框只用于**替换**，已存在的 Key 不会回显明文（上游设计如此，那里只显示「当前状态：已配置」）。

要拿到当前 Key 填进客户端，二选一：

**方式一（推荐，在 NAS 上执行）：**

```sh
sudo /var/apps/Router2API/cmd/show-api-key
```

只想把 Key 本身取出来（便于管道复制）：

```sh
sudo /var/apps/Router2API/cmd/show-api-key --quiet
```

**方式二（已登录管理后台时，在浏览器控制台执行）：**

```js
fetch('/api/admin/api-key/raw').then(r => r.json()).then(console.log)
```

拿到后填到客户端的 API Key 处，或作为 `Authorization: Bearer <key>` 请求头使用。

> Key 存在 `/vol1/@appdata/Router2API/Config/Config.json` 的 `Auth.ApiKey.Key` 字段，文件权限 600，因此需要用 root 读取。
> 想换成自己记得住的固定 Key，直接在「配置中心 → 替换 API Key」里填一个保存即可（留空表示保持当前 Key）。

## 关于本源

本仓库自行从上游源码构建并发布 fpk（tag：`Router2API-<版本>`），索引里的下载地址指向本源，不依赖任何第三方 fork。
应用中心显示的**作者为最上游项目作者**。

发布版本号在跟随上游的基础上保证**数字段单调递增**（例如上游 `2.0.9` 重发时为 `2.0.9.1`），这样飞牛应用中心才能正确提示更新。
