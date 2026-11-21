# Skills Console

一个 npm 包、一份本机工作区，管理全局与项目里的 Agent Skills。

V0.2 支持扫描、搜索、文档详情、安装、卸载和打开所在目录。可以识别 Skills CLI 安装、手工目录和软链接。扫描仍然只读，安装和卸载需先预览再确认。

## 从源码运行

需要 Node.js **22.20+** 与 pnpm。使用 Node 版本管理器时，请先切换到 `.node-version` 指定的版本或更新的受支持版本。

```bash
pnpm install
pnpm build
pnpm start ui
```

命令会自动打开浏览器，并将当前目录作为本次会话的项目。终端中的访问链接包含本次会话凭据，服务只监听 `127.0.0.1`；停止后链接失效。不要将该链接转发给其他人。

这还是本地项目，尚未发布 npm 包。完成发布后才能用 `npx skills-console ui` 启动；现在也可以通过 `pnpm pack` 生成 npm 安装包。

## 命令

```bash
# 指定本次会话项目（不会自动写入项目登记配置）
pnpm start ui --project /absolute/path/to/project

# 固定端口、不自动打开浏览器
pnpm start ui --port 4317 --no-open

# 全局 / 项目盘点
pnpm start list --global
pnpm start list --project /absolute/path/to/project --json

# UI 的额外全局扫描目录，或隔离 home 和本工具配置
pnpm start ui --root /absolute/path/to/custom-skills
pnpm start ui --home /absolute/path/to/test-home --config /absolute/path/to/config.json
```

`list` 不指定项目时扫描全局，`--global` 与 `--project` 不能同时使用。`--home` 指定独立目录时，不自动套用真实账号的 `CODEX_HOME` / `XDG_STATE_HOME`。

## 界面

- 侧栏切换全局或项目；“添加项目”将项目路径登记到本工具配置，不改动项目文件。
- 搜索名称、描述、来源；按工具、来源类型或诊断筛选。`/` 聚焦搜索，`Esc` 关闭详情或对话框。
- 点击 Skill 查看 Markdown、各安装入口、真实位置、版本证据和资源清单。
- 项目视图可选“包含全局可见候选”。它不代表 Agent 在某次对话中真的加载或调用。
- “刷新扫描”重新读取文件，不请求远端。列表中的扫描位置可展开，查看缺失或读取失败的目录。

## 安装、卸载和打开目录

界面右上角选择“安装 Skill”，输入 `owner/repo`、Git URL、GitHub tree 目录地址或本机目录（建议绝对路径或 `~/` 开头）。远端来源需要系统 Git，可选分支、标签或固定提交；私有仓库复用本机 Git 凭据，不在地址中填写密码或 token。

读取来源后选择 Skill、全局或已登记项目，以及 Codex / Claude Code / Cursor。安装预览展示确定的来源、提交和目标位置，确认后复制内容到该范围的 `.agents/skills/<name>`，再创建所选工具入口。共享目录也可能被其他读取它的工具发现。

- 新安装不会覆盖已有目录、链接或同名锁记录。重新安装请先处理原安装。
- 详情页“打开目录”启动本机 Finder / Explorer / 文件管理器；每个安装入口旁也有目录按钮。失效链接打开其上级目录。
- 详情页“卸载”允许选择安装位置。单独移除工具链接不会删除源内容；移除共享内容时会检查所有已登记项目的已知关联，仍被引用则停止。
- 卸载将所选位置移入备份，不执行永久删除。本次会话可点击“撤销卸载”；原位置被占用、备份或锁文件已有后续变化时停止恢复。
- 内置/外部托管的内容交由原工具卸载，仍可打开目录；安装根目录本身是链接时，内容应在原目录中管理。
- 本次不支持覆盖升级、含内部软链接的安装包、超过 20 MiB / 2000 项的安装内容，也不执行 Skill 中的脚本。`node_modules`、`.git`、`metadata.json` 和运行缓存不复制。

备份与操作记录位于本工具配置所在目录的 `operations/<操作ID>/`，记录文件仅当前用户可读。重启后保留备份，但自动撤销入口不跨会话恢复，可依据 `operation.json` 手动处理。跨磁盘不能直接移动备份时会停止并保留原内容。浏览器操作期间请保持本机服务运行。

## 兼容范围

默认扫描共享 `.agents/skills`、Codex `.codex/skills`、Claude Code `.claude/skills`、Cursor `.cursor/skills`，同时读取全局和项目各自的 lock。根目录下的容器最多向内发现三层；详情文件清单有数量与深度上限，超限会提示。

| 安装类型                         | 当前处理                                   |
| -------------------------------- | ------------------------------------------ |
| Skills CLI，共享目录中有对应记录 | 展示来源、ref、commit 和带算法标识的锁记录 |
| 手工复制目录                     | 展示文档和位置，版本未知不会伪装成最新     |
| 指向同一内容的多个链接           | 同一范围合并展示，保留所有入口             |
| 同名但独立的目录                 | 分别展示，不按名称合并或套用来源           |
| 内置技能、识别出的外部托管目录   | 标记外部管理                               |
| 无效文档、坏链接、异常 lock      | 保留条目或显示诊断，其余目录继续读取       |

全局 lock 兼容 schema 3，项目 lock 兼容 schema 1/2。未知格式只报告，不迁移。工具专用目录中的独立副本若只有同名 lock 记录，会提示来源尚未核实。

声明版本只是作者提供的值；安装提交和哈希是 lock 中的记录，本切片尚未通过重放或完整内容基线核验。资源中的内部链接仅列出，不跟随；超出内容目录的 SKILL.md 链接不读取。

## 数据位置

项目登记的默认位置：

```text
~/.config/skills-console/config.json
```

通过 `--config` 可覆盖。盘点原地读取文件；安装快照使用临时目录，卸载备份与操作记录保存在配置目录旁的 `operations/`。会话凭据只存在于进程和浏览器会话，不写进项目配置。异常项目配置不会被空配置覆盖。

## 开发与验证

```bash
pnpm check
pnpm test
pnpm build
pnpm smoke
pnpm test:e2e # 使用本机 Google Chrome
```

测试使用临时 home / 项目创建真实文件和链接，不连接线上账号或修改现有技能。开发系统需要使用受支持的 Node；pnpm 本身可运行并不代表其子进程 PATH 中的 Node 也满足版本要求。

当前优先验证 macOS。目录和链接实现兼顾 Windows / Linux；尚未在这些系统上实测，不宣称已有完整平台验证。

## 后续阶段

尚未提供上游更新检查和覆盖升级。后续将补充手工来源关联、可信内容基线及三方差异比较；现有安装和卸载使用独立的预览、备份与恢复流程。

- [产品方案](docs/product.md)
- [技术方案](docs/architecture.md)

MIT License.
