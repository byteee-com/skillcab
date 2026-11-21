# Skills Console 技术方案

2026 年 11 月 21 日。盘点、显式安装/卸载、版本检查和来源登记已实现；覆盖更新后续扩展。

## 运行和分发

TypeScript / ESM，Node.js 22.20+。前端 React + Vite；本地服务 Fastify；CLI 使用 Commander。UI 静态资源与编译后的 CLI、core、server 一起发布到一个 npm 包。

选择精确且发布满七天的依赖版本。开发工具只存在于 devDependencies，不要求用户安装构建工具、Rust 或数据库。

当前工作目录仅作为默认项目，不能在不知情时递归扫描整个主目录。已登记项目存在本工具的用户配置文件，后台启动参数提供的项目也会登记到配置。支持 `--home`/`--config` 以便隔离测试。

## 模块边界

```text
CLI ───────┐
           ├── Core：扫描、安装模型、来源证据、版本与操作规划
HTTP API ──┘       ├── 工具目录适配
  │                ├── Skills lock 格式适配
Web UI             └── 文件系统 / 来源 / 本工具存储
```

- `src/core` 不依赖 React、HTTP 或命令行展示。
- `src/server` 负责本机后台服务、请求边界、配置持久化及静态资源。
- `src/web` 通过类型化 API 获取数据，不直接访问磁盘。
- CLI `list` 与服务端扫描调用同一函数。

不在运行时执行 `npx skills@latest`，不解析颜色、进度条或交互提示。当前来源层通过系统 Git 获取仓库快照并保留 ref / commit / Git tree 证据，本地来源直接读取目录；先写 staging，再由操作层规划真实安装。来源层可后续替换为固定版本的 SDK，避免将其全局目录写入策略耦合到操作层。

## 扫描

内置共享 `.agents/skills`、历史/当前 `.codex/skills`、`.claude/skills`、`.cursor/skills`，支持自定义全局与项目子目录。`CODEX_HOME` 与上游 XDG lock 路径需要显式适配，不能修改进程 HOME。

枚举登记根目录下的安装入口；对容器目录进行有深度和数量限制的发现，以识别嵌套 Skill。跳过 `.git`、`node_modules` 等无关目录。根目录消失是正常无安装，权限错误必须报告。单一位置失败不终止其他位置。

对入口使用 lstat、readlink 与 realpath；外层链接可以指向项目源目录，只读扫描允许读取其 SKILL.md。详情资源枚举不跟随内容内部越界链接，防止循环和将无关目录全部暴露。对损坏链接保留入口。

相同 scope 下、相同 realpath 的多入口合并展示，保留全部 Location；同名而 realpath 不同的内容不合并。稳定 ID 来自 scope 身份和实际内容位置，不取决于列表顺序。

扫描返回读取问题、是否截断、根目录情况与完成时间。没有条目和扫描不完整是不同状态。

## 数据模型

| 对象           | 主要字段                                                                |
| -------------- | ----------------------------------------------------------------------- |
| Project        | id、name、path、canonicalPath                                           |
| Scope          | global / project、projectId                                             |
| Installation   | id、scope、name、metadata、locations、realPath、diagnostics             |
| Location       | entryPath、rootPath、tool、symlinkTarget、linkState                     |
| Provenance     | manager、recordPath、recordKey、source、ref、commit、hashes、confidence |
| Detail         | Installation、原文、Markdown 正文、文件清单、诊断                       |
| Baseline（B）  | 算法版本、可信文件清单、来源快照与对应提交                              |
| Operation（C） | 预览、前置条件、快照、执行日志、恢复状态                                |

索引可重建；Skill 文件是安装事实。上游 lock 是来源证据，不是唯一安装清单。本工具配置不是第二份事实副本。

## Skills CLI 兼容

全局 lock：`$XDG_STATE_HOME/skills/.skill-lock.json`，未配置时 `~/.agents/.skill-lock.json`。当前上游 schema 为 3。

项目 lock：项目根目录的 `skills-lock.json`；读 schema 1 和 2。读取绝不隐式迁移或保存。未知 schema 给出诊断，扫描继续。

按 scope 隔离 lock；将记录绑定到同 scope 的 canonical 安装位置，或明确指向该位置的工具链接。对于同名但独立的工具目录副本，不能仅凭名称附加来源；应展示“发现同名记录但未核实”。

保留来源 URL、子路径、重命名前名称、ref、commit、installMode 以及算法类型。脱敏显示 URL 中用户信息、query、token/password 字段，避免将凭据送到前端或日志。

后续写入仅修改任务负责的条目，保留未知字段和其他技能；未知 schema 不写。实现单独 hash-v1/hash-v2/git-tree 适配，不能把算法不同的值直接比较。

## 本地服务边界

- 只绑定 `127.0.0.1`，默认固定端口 59726（--port 0 动态选择）；可指定端口。
- 无需 Token，本机地址可直接打开；默认 detached 子进程运行，stdio 写入本工具日志，不依赖启动终端。
- 验证 Host / Origin / Sec-Fetch-Site，写请求要求 X-Skills-Console: 1，拒绝跨站请求，不启用宽泛 CORS。
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

Fastify inject 验证直接本机访问、写请求头、Host/Origin、项目登记和详情越权边界。浏览器验证全局/项目切换、搜索、筛选、详情、错误/空状态、键盘及窄屏。

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

## V0.2 操作实现

`src/core/sources.ts` 发现 Skill、固定 Git 提交并准备受限内容副本；`src/core/operations.ts` 按 scope 建立一次性、带过期时间的预览，串行执行变更。真实文件夹只在 apply 时创建；使用独占创建和复制，不替换已有目标。源内容中的符号链接不跟随，含此类资源的安装停止。

操作重新验证目标目录指纹、父目录身份与 lock 原文。全局 GitHub 记录使用原仓库 Skill 目录的 Git tree ID，其他内容哈希及项目 v1/v2 哈希独立处理。保留现有 lock schema、其他记录和未知字段；不将坏 lock 当空文件写回。

卸载将原位置 rename 到 `operations/<id>/location-N`，软链接本身被移动而非源目录。记录预览位置、lock 前后原文和移动清单，权限为目录 0700、记录 0600。单次进程支持撤销卸载，先核对备份、原路径未占用及 lock 原文，后续有变化则停止。跨磁盘移动不回退为先删除后复制。

HTTP 写入和目录打开使用上述本机请求边界校验。安装来源/预览 ID、卸载安装 ID 与入口索引由服务器映射到路径，前端不能提交任意删除或打开路径。目录打开模块只使用 spawn 参数数组、shell=false；浏览器测试注入捕获路径的替身，不弹出用户 Finder。

不承诺与不遵守本工具锁的外部 CLI 间存在跨文件原子事务。安装发生部分复制失败时保留无法确认归属的内容和恢复记录；成功操作后的记录保存失败作为警告返回，不回滚已经提交的内容和 lock。自动跨会话恢复、覆盖安装和更新仍未开放。

## V0.3 版本与后台服务实现

`core/updates.ts` 的 VersionService 将来源关联与检查结果独立保存为配置旁 `versions.json`。记录以稳定 Installation ID 和 realPath 隔离，真实 CLI 来源优先，手动登记不改上游 lock；损坏数据不覆盖。写入串行化、重读原文并使用临时文件替换，权限 0600。它不承诺与外部进程的跨文件原子事务。

检查使用来源层取得 Git / 本地快照，以 skillPath 精确定位（兼容 SKILL.md 路径），缺少路径时按原名称唯一匹配，多候选停止并要求子目录。GitHub 使用原仓库 tree SHA；项目 schema 1/2 各自计算对应内容哈希；手动核验使用 v2 内容哈希。本工具 V0.3 的非 GitHub 全局安装在锁记录增加 skillFolderHashAlgorithm=skills-content-v2，明确区分内容哈希与外部未知算法，其他 CLI 可忽略此扩展字段。旧的未标注算法记录不被强行按 v2 解读。重命名按安装名称规范化临时文档后比较，声明版本不参与比较。标签/固定提交原样传给 Git，默认分支未指定时解析实际分支。

不依赖 Git 仓库整体 HEAD 判断更新。上游状态与 localState 分离；无法确定本地基线时 localState 保持 unknown。所有内容核验经过受限临时复制（20 MiB / 2000 项，不跟随内部软链接），不执行脚本。结果键包括来源证据和手动关联，附本地内容指纹、时间和来源版本；刷新不联网，来源/锁或本地内容变化使缓存失效；24 小时后需要重新检查。批次最多 3 项并发，相同来源/ref 的获取共用 Promise，finally 清理所有临时仓库。

`server/service.ts` 通过 detached 子进程、关闭 stdin、独立日志启动后台服务。配置目录的 service.json 记录 PID、URL 和随机实例标识；实例标识只用于避免旧 PID 记录误杀，非网页访问凭据。status / stop 在发信号前用回环 health 响应核对应用、实例和 PID；无法确认时不发信号。启动锁阻止并发启动，启动失败保留日志并给出路径。无开机自启；构建新版本后需 stop / ui 重启。

工具 SVG 由 Lobe Icons 的 Claude / Codex / Cursor 图标本地打包，按 MIT 保留许可证，见 third-party-notices.md；页面不请求第三方图片。
