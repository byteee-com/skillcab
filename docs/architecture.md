# Skills Console 技术方案

2026 年 11 月 17 日。实现顺序为只读盘点、可信检查、可恢复写入。

## 运行和分发

TypeScript / ESM，Node.js 22.20+。前端 React + Vite；本地服务 Fastify；CLI 使用 Commander。UI 静态资源与编译后的 CLI、core、server 一起发布到一个 npm 包。

选择精确且发布满七天的依赖版本。开发工具只存在于 devDependencies，不要求用户安装构建工具、Rust 或数据库。

当前工作目录仅作为默认项目，不能在不知情时递归扫描整个主目录。已登记项目存在本工具的用户配置文件，启动参数提供的临时项目可不持久化。支持 `--home`/`--config` 以便隔离测试。

## 模块边界

```text
CLI ───────┐
           ├── Core：扫描、安装模型、来源证据、版本与操作规划
HTTP API ──┘       ├── 工具目录适配
  │                ├── Skills lock 格式适配
Web UI             └── 文件系统 / 来源 / 本工具存储
```

- `src/core` 不依赖 React、HTTP 或命令行展示。
- `src/server` 负责会话、请求边界、配置持久化及静态资源。
- `src/web` 通过类型化 API 获取数据，不直接访问磁盘。
- CLI `list` 与服务端扫描调用同一函数。

不在运行时执行 `npx skills@latest`，不解析颜色、进度条或交互提示。后续来源获取和安装优先通过固定版本的 `skills` 公共 API 适配，先写 staging，再由操作层规划真实安装。

## 扫描

内置共享 `.agents/skills`、历史/当前 `.codex/skills`、`.claude/skills`、`.cursor/skills`，支持自定义全局与项目子目录。`CODEX_HOME` 与上游 XDG lock 路径需要显式适配，不能修改进程 HOME。

枚举登记根目录下的安装入口；对容器目录进行有深度和数量限制的发现，以识别嵌套 Skill。跳过 `.git`、`node_modules` 等无关目录。根目录消失是正常无安装，权限错误必须报告。单一位置失败不终止其他位置。

对入口使用 lstat、readlink 与 realpath；外层链接可以指向项目源目录，只读扫描允许读取其 SKILL.md。详情资源枚举不跟随内容内部越界链接，防止循环和将无关目录全部暴露。对损坏链接保留入口。

相同 scope 下、相同 realpath 的多入口合并展示，保留全部 Location；同名而 realpath 不同的内容不合并。稳定 ID 来自 scope 身份和实际内容位置，不取决于列表顺序。

扫描返回读取问题、是否截断、根目录情况与完成时间。没有条目和扫描不完整是不同状态。

## 数据模型

| 对象 | 主要字段 |
| --- | --- |
| Project | id、name、path、canonicalPath |
| Scope | global / project、projectId |
| Installation | id、scope、name、metadata、locations、realPath、diagnostics |
| Location | entryPath、rootPath、tool、symlinkTarget、linkState |
| Provenance | manager、recordPath、recordKey、source、ref、commit、hashes、confidence |
| Detail | Installation、原文、Markdown 正文、文件清单、诊断 |
| Baseline（B） | 算法版本、可信文件清单、来源快照与对应提交 |
| Operation（C） | 预览、前置条件、快照、执行日志、恢复状态 |

索引可重建；Skill 文件是安装事实。上游 lock 是来源证据，不是唯一安装清单。本工具配置不是第二份事实副本。

## Skills CLI 兼容

全局 lock：`$XDG_STATE_HOME/skills/.skill-lock.json`，未配置时 `~/.agents/.skill-lock.json`。当前上游 schema 为 3。

项目 lock：项目根目录的 `skills-lock.json`；读 schema 1 和 2。读取绝不隐式迁移或保存。未知 schema 给出诊断，扫描继续。

按 scope 隔离 lock；将记录绑定到同 scope 的 canonical 安装位置，或明确指向该位置的工具链接。对于同名但独立的工具目录副本，不能仅凭名称附加来源；应展示“发现同名记录但未核实”。

保留来源 URL、子路径、重命名前名称、ref、commit、installMode 以及算法类型。脱敏显示 URL 中用户信息、query、token/password 字段，避免将凭据送到前端或日志。

后续写入仅修改任务负责的条目，保留未知字段和其他技能；未知 schema 不写。实现单独 hash-v1/hash-v2/git-tree 适配，不能把算法不同的值直接比较。

## 本地服务边界

- 只绑定 `127.0.0.1`，默认动态空闲端口；可指定端口。
- 为每次启动生成随机凭据，通过页面 fragment 引导会话，不写访问日志或持久化配置。
- 本地文档 API 需要凭据；验证 Host / Origin，拒绝跨站请求，不启用宽泛 CORS。
- 通过受控 ID 读取详情，不提供任意文件下载接口。
- 项目添加在服务端验证目录，规范化路径、去重；只持久化登记信息，不修改项目。
- 所有 Skill 文本是不可信内容，Markdown 禁用 raw HTML，不执行附带脚本，外链安全打开。
- 设置尺寸、数量、扫描深度、文档长度与响应上限。明确返回截断情况。

## 更新和恢复（B/C）

分别比较 Base 与 Local、Base 与 Upstream。手工关联不一致时 Base 仍未知，不能误记为干净安装。分支跟踪更新，标签/固定提交默认保持原目标，切换目标独立预览。

流程：获取并固定候选 → 解析内容 → 计算文件差异与所有已知关联 → 预览 → 校验前置状态 → 备份 → 分步写入内容和 lock → 验证 → 记录结果。

多文件事务依赖操作日志和可恢复步骤，不能宣称跨文件原子提交。本工具内部串行化写入；外部 CLI 不遵守本工具锁，因此预览与执行必须检查快照变化，发生冲突时停止，失败恢复前再次核对目标，避免覆盖用户后续修改。

不删除软链接源目录来“禁用工具”；删除关联与删除源内容分开。

## 测试和交付

Vitest 使用临时 home/project 创建真实目录、文件和链接；测试 scope 隔离、重复名称、同 realpath 合并、坏链接、嵌套目录、文档错误、lock 1/2/3 和未知 schema、来源脱敏、资源越界链接、只读不变性。

Fastify inject 验证会话、Host/Origin、项目登记和详情越权边界。浏览器验证全局/项目切换、搜索、筛选、详情、错误/空状态、键盘及窄屏。

打包后验证 CLI 二进制入口、静态资源位置、npm pack 清单。全局 CLI 是开发者可选择的安装方式，源码运行不依赖真实 npm 发布。

## 上游参考

- [Agent Skills 格式](https://agentskills.io/specification)
- [Skills CLI 命令](https://github.com/vercel-labs/skills/blob/main/docs/commands.md)
- [工具目录规则](https://github.com/vercel-labs/skills/blob/main/docs/agents.md)
- [公共程序 API](https://github.com/vercel-labs/skills/blob/main/docs/api.md)
- [全局 lock](https://github.com/vercel-labs/skills/blob/main/src/skill-lock.ts)
- [项目 lock](https://github.com/vercel-labs/skills/blob/main/src/local-lock.ts)
- [内容哈希](https://github.com/vercel-labs/skills/blob/main/src/skill-hash.ts)

兼容依据必须在升级依赖时重新核验，不能把 main 分支内容当作固定协议。
