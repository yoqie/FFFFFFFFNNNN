# DSH（DeepSeek Harness 飞牛版）

- 上游: https://github.com/deepseek-ai/deepseek-harness
- 构建: 本源（FFFFFFFFNNN）的 GitHub Actions 直接从上游源码构建，amd64 + arm64 原生双架构
- 分发: 产物发布在本仓库 Release（tag: `dsh-<版本>`），索引里的下载地址指向本源；只认本源自建的包，不依赖任何第三方 fork
- 服务端口: 3080（与官方 deepseek-harness 一致）
- 依赖: 飞牛应用中心 nodejs_v24 运行时（缺失时自动安装）
- 数据目录: /vol1/@appshare/dsh
- 卸载数据: 默认保留；卸载向导可选「只删会话与凭据（.dsh）」或「删除全部应用数据（含 Documents 工作区）」

安装后桌面出现 DSH 卡片，点击或访问 http://NAS地址:3080 使用。
