# Router2API

.NET 10 模型路由宿主：把不同提供方的模型统一成 OpenAI 兼容接口，自带 Vue 3 管理后台。本源分发的是**飞牛 fnOS 原生包**（`.fpk`，非 Docker）。

- 最上游项目（作者 NNNNolan）：https://github.com/NNNNolan/Router2API
- 飞牛打包仓库：https://github.com/cliii-one/Router2API
- 安装类型：系统空间（root），服务端口 5242（固定）
- 依赖：无需额外依赖——包内是 .NET 自包含运行时，并内置 redis-server（仅监听 127.0.0.1）
- 数据目录：应用 var 目录（如 `/vol1/@appdata/Router2API`）——升级不丢配置、密钥、数据库与插件
- 安装完成后访问 `http://<NAS地址>:5242/` 进入管理后台

## 关于本源

本仓库只做**镜像分发**：Release 里的 fpk 与上游 `cliii-one/Router2API` 逐字节一致，sha256 随索引一并公布，可自行校验。
应用中心显示的**作者为最上游项目作者 NNNNolan**（打包与自动构建由 `cliii-one/Router2API` 完成）。
