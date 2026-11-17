#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { scanSkills } from "./core/scanner.js";
import { toolNames } from "./core/paths.js";
import { createServer } from "./server/index.js";

const program = new Command()
  .name("skills-console")
  .description("全局与项目 Agent Skills 的本机只读盘点工具")
  .version("0.1.0");
program
  .command("list")
  .description("扫描并列出实际安装，不修改 Skill 或 lock")
  .option("-g, --global", "扫描全局目录")
  .option("-p, --project <path>", "扫描指定项目")
  .option("--home <path>", "指定用户目录，用于隔离扫描", homedir())
  .option("--root <path...>", "额外扫描目录")
  .option("--json", "输出完整 JSON")
  .action(async (options) => {
    if (options.global && options.project)
      throw new Error("--global 与 --project 不可同时使用。");
    const home = resolve(options.home);
    const project = options.project ? resolve(options.project) : undefined;
    if (project && !(await stat(project)).isDirectory())
      throw new Error("项目路径不是目录。");
    const result = await scanSkills({
      home,
      project,
      codexHome: home === homedir() ? process.env.CODEX_HOME : undefined,
      xdgStateHome: home === homedir() ? process.env.XDG_STATE_HOME : undefined,
      additionalRoots: options.root?.map((path: string) => ({
        path,
        tool: "custom" as const,
      })),
    });
    if (options.json)
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else {
      console.log(
        `\n${result.scope.name}  ·  ${result.installations.length} skills\n${result.scope.path}\n`,
      );
      console.table(
        result.installations.map((item) => ({
          Skill: item.name,
          Tools: [
            ...new Set(item.locations.map((l) => toolNames[l.tool])),
          ].join(", "),
          Source:
            item.provenance?.source ??
            (item.manager === "external" ? "外部管理" : "本地内容"),
          Version:
            item.declaredVersion ??
            item.provenance?.commit?.slice(0, 8) ??
            "未知",
          Status: item.diagnostics.length ? "需留意" : "可读取",
        })),
      );
      if (result.diagnostics.length)
        console.error(
          `${result.diagnostics.length} 条扫描提示；使用 --json 查看详情。`,
        );
    }
  });
program
  .command("ui", { isDefault: true })
  .description("启动本机 Web UI")
  .option("--project <path...>", "添加本次会话的项目（可传多个路径）")
  .option("--home <path>", "指定用户目录，用于隔离扫描", homedir())
  .option("--config <path>", "指定本工具项目配置文件")
  .option("--root <path...>", "额外的全局扫描目录")
  .option("--port <number>", "指定端口；默认使用随机空闲端口", "0")
  .option("--no-open", "不自动打开浏览器")
  .action(async (options) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("端口须为 0 到 65535 的整数。");
    const home = resolve(options.home);
    const projects =
      options.project ?? (process.cwd() !== home ? [process.cwd()] : []);
    const { app, token } = await createServer({
      home,
      projects,
      configPath: options.config ? resolve(options.config) : undefined,
      codexHome: home === homedir() ? process.env.CODEX_HOME : undefined,
      xdgStateHome: home === homedir() ? process.env.XDG_STATE_HOME : undefined,
      additionalRoots: options.root?.map((path: string) => ({
        path,
        tool: "custom" as const,
      })),
    });
    const address = await app.listen({ host: "127.0.0.1", port });
    const url = `${address}/#token=${token}`;
    console.log(
      `\n  Skills Console  v0.1.0\n  ${url}\n\n  只读扫描 · Ctrl+C 停止服务\n`,
    );
    if (options.open) {
      const [command, args] =
        process.platform === "darwin"
          ? ["open", [url]]
          : process.platform === "win32"
            ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
            : ["xdg-open", [url]];
      spawn(command, args, { stdio: "ignore", detached: true })
        .on("error", () =>
          console.error("无法自动打开浏览器，请使用上面的链接。"),
        )
        .unref();
    }
    const shutdown = () => {
      void app.close().then(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : "命令执行失败。");
  process.exitCode = 1;
});
