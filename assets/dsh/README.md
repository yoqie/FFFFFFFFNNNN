# DSH（DeepSeek Harness 飞牛版）

- 上游与打包: https://github.com/cliii-one/DSH_FNOS
- 构建方式: GitHub Actions（amd64 + arm64 原生双架构），上游发布 Release
- 分发: 本源把最新版 fpk 镜像到本仓库 Release（tag: `dsh-<版本>`），索引里的下载地址指向本源，不再依赖上游仓库
- 服务端口: 3082（与官方 deepseek-harness 应用的 3080 互不冲突，可并存）
- 依赖: 飞牛应用中心 nodejs_v24 运行时（缺失时自动安装）
- 数据目录: /vol2/@appshare/dsh

安装后桌面出现 DSH 卡片，点击或访问 http://NAS地址:3082 使用。
