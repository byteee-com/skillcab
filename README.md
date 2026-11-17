# Skills Console

一个 npm 包、一份本机工作区，查看全局与项目里的 Agent Skills。

目前交付 V1 的只读盘点：扫描、搜索、筛选、文档详情、安装位置、来源和版本记录。可以识别 Skills CLI 安装、手工目录和软链接。扫描不会移动文件、修复链接或修改 Skill / 上游 lock。

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

本工具只持久化登记的项目路径，默认位置：

```text
~/.config/skills-console/config.json
```

通过 `--config` 可覆盖。Skill 和上游 lock 原地读取，不复制进本工具。会话凭据只存在于进程和浏览器会话，不写进项目配置。异常项目配置不会被空配置覆盖。

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

本轮没有远端更新检查和写入功能。接下来是手工来源关联、可信基线、上游变化比较，再进入预览更新、备份与恢复。

- [产品方案](docs/product.md)
- [技术方案](docs/architecture.md)

MIT License.
