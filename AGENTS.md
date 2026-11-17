# Skills Console

本机 Skill 管理工具，一个 npm 包，提供 CLI 和本地 Web UI。

- 产品范围见 `docs/product.md`，架构与兼容约定见 `docs/architecture.md`。
- 首个 V1 切片是只读扫描、列表和详情。不要在扫描中移动文件、修复链接、修改 Skill 或上游 lock。
- 文件系统是实际安装的依据，lock 只提供来源证据。无法判断时必须展示未知，不伪造版本、本地修改或 Agent 实际调用状态。
- 同名不代表同一 Skill。安装位置标识安装，realpath 用于识别共享内容。
- 新依赖使用发布满 7 天的精确版本；保持 npm 分发无需原生编译。
- 更改后运行 `pnpm check`、`pnpm test`、`pnpm build`。扫描、来源证据和本地服务边界需要有实际文件系统测试。
- 使用 Conventional Commits；只提交本任务文件。推送使用已配置 upstream，缺少 remote 时保留本地提交并报告，不擅自创建远程仓库。
