# yoqie · 跟随源

飞牛 fnOS 个人第三方应用源（个人维护，非 FnDepot 官方源）——由 GitHub Actions 跟随 [1Panel 官方](https://github.com/1Panel-dev/1Panel)、[DSH 官方上游](https://github.com/deepseek-ai/deepseek-harness)、官方 Node.js 与 `apps.allowlist.txt` 名单中的应用市场应用自动打包更新。

- 源地址（添加到 FnDepot/AppCenter 第三方源）：`https://github.com/yoqie/FFFFFFFFNNNN` 或 `https://raw.githubusercontent.com/yoqie/FFFFFFFFNNNN/main/fnpack.json`
- 跟随：1Panel 面板 v2、DSH（DeepSeek Harness，amd64/arm64 双架构）、Router2API（.NET 10 模型路由宿主，amd64/arm64 双架构） + `apps.allowlist.txt` 名单中的应用市场应用
- 同步频率：每天一次（可手动触发），有新版本时自动打包 FPK 并发布 Release；同一应用只保留最新版 Release。

## 应用列表

| 应用 | 描述 | 上游版本 |
|------|------|----------|
| [1Panel](build/1panel/) | 开源服务器运维管理面板，提供可视化的 Linux 服务器管理。 | 2.4.1 |
| [DSH](build/dsh/) | DeepSeek Harness（DSH）飞牛NAS版：自动跟进上游最新版本构建，amd64/arm64 双架构原生安装包，飞牛桌面一键打开。 | 0.2.1-rc.3.1 |
| [Router2API](build/Router2API/) | .NET 10 模型路由宿主，把不同提供方的模型统一成 OpenAI 兼容接口，自带 Vue 3 管理后台。包内集成 .NET 自包含运行时与 Redis 运行态，安装即用，无需 Docker。 | 2.1.2 |
