#!/usr/bin/env node
import { Command } from "commander";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { stat, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { version } from "../package.json";
import { VersionService } from "./core/updates.js";
import {
  defaultPort,
  startBackground,
  runningService,
  stopService,
  servicePath,
} from "./server/service.js";
import { scanSkills } from "./core/scanner.js";
import { toolNames } from "./core/paths.js";
import { createServer } from "./server/index.js";

const program = new Command()
  .name("skillcab")
  .description("全局与项目 Agent Skills 的本机管理工具")
  .version(version);
program
  .command("list")
  .description("扫描并列出实际安装，不修改 Skill 或 lock")
  .option("-g, --global", "扫描全局目录")
  .option("-p, --project <path>", "扫描指定项目")
  .option("--home <path>", "指定用户目录，用于隔离扫描", homedir())
  .option("--root <path...>", "额外扫描目录")
  .option("--json", "输出完整 JSON")
  .option("--config <path>", "指定本工具配置文件，读取来源和检查缓存")
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
    const config = options.config
      ? resolve(options.config)
      : join(home, ".config/skills-console/config.json");
    await new VersionService(
      join(dirname(config), "versions.json"),
      home,
    ).decorate(result);
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
            item.tracking?.source ??
            (item.manager === "external" ? "外部管理" : "本地内容"),
          Version:
            item.declaredVersion ??
            item.provenance?.commit?.slice(0, 8) ??
            item.tracking?.baseline?.commit?.slice(0, 8) ??
            item.provenance?.hash?.value.slice(0, 8) ??
            item.tracking?.baseline?.hash.slice(0, 8) ??
            "未知",
          Update: item.update?.status,
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
  .option(
    "--port <number>",
    `指定端口；默认 ${defaultPort}（0 使用随机端口）`,
    String(defaultPort),
  )
  .option("--no-open", "不自动打开浏览器")
  .option("--foreground", "在前台运行；Ctrl+C 停止")
  .action(async (options, command: Command) => {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      throw new Error("端口须为 0 到 65535 的整数。");
    const home = resolve(options.home);
    const projects =
      options.project ?? (process.cwd() !== home ? [process.cwd()] : []);
    const configPath = options.config
      ? resolve(options.config)
      : join(home, ".config/skills-console/config.json");
    let url: string;
    if (!options.foreground) {
      const { record, reused, upgradedFrom } = await startBackground(
        configPath,
        {
          version,
          home:
            command.getOptionValueSource("home") === "cli" ? home : undefined,
          port:
            command.getOptionValueSource("port") === "cli" ? port : undefined,
          projects: options.project,
          roots: options.root,
        },
      );
      url = record.url;
      for (const path of projects) {
        const response = await fetch(`${url}api/projects`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Skills-Console": "1",
          },
          body: JSON.stringify({
            path: path.startsWith("~/") ? path : resolve(path),
          }),
        });
        if (!response.ok)
          console.error(
            "项目登记失败：",
            ((await response.json()) as { error: string }).error,
          );
      }
      const action = upgradedFrom
        ? `已从 v${upgradedFrom} 升级`
        : reused
          ? "已连接现有"
          : "已启动";
      const runningVersion = record.appVersion ? `  v${record.appVersion}` : "";
      console.log(
        `\n  skillcab${runningVersion}\n  ${url}\n\n  ${action}后台服务 · 关闭终端后继续运行\n  npx skillcab stop 停止 · npx skillcab status 查看状态\n`,
      );
      if (reused && options.root?.length)
        console.log("已有服务的扫描根目录保持原配置；修改 --root 请先 stop。 ");
    } else {
      const instanceId = randomUUID();
      const { app } = await createServer({
        home,
        projects,
        configPath,
        instanceId,
        codexHome: home === homedir() ? process.env.CODEX_HOME : undefined,
        xdgStateHome:
          home === homedir() ? process.env.XDG_STATE_HOME : undefined,
        additionalRoots: options.root?.map((path: string) => ({
          path,
          tool: "custom" as const,
        })),
      });
      url = `${await app.listen({ host: "127.0.0.1", port })}/`;
      let closing = false;
      const shutdown = () => {
        if (closing) return;
        closing = true;
        void app.close().then(async () => {
          const record = JSON.parse(
            await readFile(servicePath(configPath), "utf8").catch(() => "{}"),
          );
          if (record.instanceId === instanceId)
            await rm(servicePath(configPath), { force: true });
          process.exit(0);
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      if (process.env.SKILLS_CONSOLE_BACKGROUND === "1") {
        await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
        await writeFile(
          servicePath(configPath),
          JSON.stringify({
            version: 1,
            pid: process.pid,
            url,
            instanceId,
            roots: ((options.root ?? []) as string[]).map((path) =>
              resolve(path),
            ),
          }),
          { mode: 0o600 },
        );
      }
      console.log(
        `\n  skillcab  v${version}\n  ${url}\n\n  扫描只读 · 操作先确认 · Ctrl+C 停止前台服务\n`,
      );
    }
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
  });
for (const command of ["status", "stop"] as const) {
  program
    .command(command)
    .description(command === "status" ? "查看后台服务状态" : "停止后台服务")
    .option("--home <path>", "用户目录", homedir())
    .option("--config <path>", "配置文件位置")
    .action(async (options) => {
      const config = options.config
        ? resolve(options.config)
        : join(resolve(options.home), ".config/skills-console/config.json");
      if (command === "stop")
        console.log(
          (await stopService(config))
            ? "后台服务已停止。"
            : "没有正在运行的后台服务。",
        );
      else {
        const running = await runningService(config);
        console.log(
          running
            ? `后台服务运行中${running.appVersion ? ` · v${running.appVersion}` : ""} · PID ${running.pid}\n${running.url}`
            : "没有正在运行的后台服务。",
        );
      }
    });
}
program
  .command("check")
  .description("只读检查指定范围内 Skill 的来源更新")
  .option("--home <path>", "用户目录", homedir())
  .option("-p, --project <path>", "项目目录")
  .option("--config <path>", "配置文件位置")
  .option("--json", "输出 JSON")
  .action(async (options) => {
    const home = resolve(options.home);
    const config = options.config
      ? resolve(options.config)
      : join(home, ".config/skills-console/config.json");
    const versions = new VersionService(
      join(dirname(config), "versions.json"),
      home,
    );
    const inventory = await scanSkills({
      home,
      project: options.project ? resolve(options.project) : undefined,
      codexHome: home === homedir() ? process.env.CODEX_HOME : undefined,
      xdgStateHome: home === homedir() ? process.env.XDG_STATE_HOME : undefined,
    });
    await versions.check(inventory);
    if (options.json) console.log(JSON.stringify(inventory, null, 2));
    else
      console.table(
        inventory.installations.map((item) => ({
          Skill: item.name,
          Status: item.update?.status,
          Message: item.update?.message,
        })),
      );
  });
program.parseAsync().catch((error) => {
  console.error(error instanceof Error ? error.message : "命令执行失败。");
  process.exitCode = 1;
});
