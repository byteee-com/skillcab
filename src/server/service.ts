import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode, plainObject } from "../core/document.js";
import { projectAt } from "./projects.js";

export interface ServiceRecord {
  version: 1;
  pid: number;
  url: string;
  instanceId: string;
  roots?: string[];
}
interface RunningService extends ServiceRecord {
  appVersion?: string;
}
interface LaunchOptions {
  version: string;
  home?: string;
  port?: number;
  projects?: string[];
  roots?: string[];
}
export const defaultPort = 59726;
export const servicePath = (config: string) =>
  join(dirname(config), "service.json");
export async function runningService(
  config: string,
): Promise<RunningService | undefined> {
  try {
    const record = JSON.parse(
      await readFile(servicePath(config), "utf8"),
    ) as ServiceRecord;
    const url = new URL(record.url);
    if (
      record.version !== 1 ||
      !Number.isInteger(record.pid) ||
      record.pid < 1 ||
      typeof record.instanceId !== "string" ||
      url.hostname !== "127.0.0.1" ||
      url.protocol !== "http:" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return;
    const response = await fetch(new URL("api/health", url), {
      signal: AbortSignal.timeout(1000),
      redirect: "error",
    });
    const health = (await response.json()) as {
      app?: string;
      instanceId?: string;
      pid?: number;
      version?: unknown;
    };
    if (
      response.ok &&
      health.app === "skills-console" &&
      health.instanceId === record.instanceId &&
      health.pid === record.pid
    )
      return {
        ...record,
        appVersion:
          typeof health.version === "string" ? health.version : undefined,
      };
  } catch {
    /* A stale record is never sufficient to signal a process. */
  }
}

function upgradeFrom(current: string | undefined, target: string): boolean {
  const parse = (value?: string) =>
    /^(\d+)\.(\d+)\.(\d+)$/
      .exec(value ?? "")
      ?.slice(1)
      .map(Number);
  const old = parse(current);
  const next = parse(target);
  if (!old || !next) return false;
  const difference = next.findIndex((part, index) => part !== old[index]);
  return difference >= 0 && next[difference] > old[difference];
}

async function withServiceLock<T>(config: string, action: () => Promise<T>) {
  await mkdir(dirname(config), { recursive: true, mode: 0o700 });
  const lockPath = `${servicePath(config)}.lock`;
  const deadline = Date.now() + 40000;
  let lock;
  for (;;) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new Error(
          `另一个服务操作尚未完成。若进程已意外退出，请删除 ${lockPath} 后重试。`,
        );
      await delay(100);
    }
  }
  try {
    return await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function serviceData(
  record: RunningService,
  path: string,
): Promise<unknown> {
  const response = await fetch(new URL(path, record.url), {
    signal: AbortSignal.timeout(10000),
    redirect: "error",
  });
  if (!response.ok) throw new Error("无法读取旧版后台配置，请稍后重试。");
  return response.json();
}

async function launchArgs(
  config: string,
  options: LaunchOptions,
  existing?: RunningService,
) {
  let home = options.home ?? homedir();
  const port =
    options.port ??
    (existing ? Number(new URL(existing.url).port || "80") : defaultPort);
  let roots = options.roots;
  let inheritedProjects: string[] = [];
  if (existing) {
    const state = await serviceData(existing, "api/state");
    if (
      !plainObject(state) ||
      typeof state.home !== "string" ||
      !isAbsolute(state.home) ||
      !Array.isArray(state.projects)
    )
      throw new Error("无法确认旧版后台的项目配置，请稍后重试。");
    home = options.home ?? state.home;
    const resolved = await Promise.all(
      state.projects.map((project: unknown) =>
        plainObject(project) &&
        typeof project.path === "string" &&
        isAbsolute(project.path)
          ? projectAt(project.path, home)
              .then((item) => item.path)
              .catch(() => undefined)
          : undefined,
      ),
    );
    inheritedProjects = resolved.filter((path) => path !== undefined);
    if (roots === undefined) {
      roots = existing.roots;
      if (
        !Array.isArray(roots) ||
        !roots.every((path) => typeof path === "string" && isAbsolute(path))
      ) {
        const inventory = await serviceData(
          existing,
          "api/inventory?scope=global",
        );
        if (!plainObject(inventory) || !Array.isArray(inventory.roots))
          throw new Error("无法确认旧版后台的扫描目录，请稍后重试。");
        roots = inventory.roots.flatMap((root: unknown) =>
          plainObject(root) &&
          root.tool === "custom" &&
          typeof root.path === "string" &&
          isAbsolute(root.path)
            ? [root.path]
            : [],
        );
      }
    }
  }
  const projects =
    options.projects ?? (process.cwd() === home ? [] : [process.cwd()]);
  const startupProjects = new Set([
    ...inheritedProjects,
    ...(
      await Promise.all(projects.map((project) => projectAt(project, home)))
    ).map((project) => project.path),
  ]);
  const args = ["--home", home, "--config", config, "--port", String(port)];
  if (startupProjects.size) args.push("--project", ...startupProjects);
  if (roots?.length) args.push("--root", ...roots);
  return args;
}

export async function startBackground(
  config: string,
  options: LaunchOptions,
): Promise<{
  record: RunningService;
  reused: boolean;
  upgradedFrom?: string;
}> {
  return withServiceLock(config, async () => {
    const existing = await runningService(config);
    if (existing && !upgradeFrom(existing.appVersion, options.version))
      return { record: existing, reused: true };
    if (existing && process.platform === "win32")
      throw new Error("Windows 上请先停止旧版后台，再启动新版。");
    const args = await launchArgs(config, options, existing);
    const log = await open(join(dirname(config), "service.log"), "a", 0o600);
    let failure: Error | undefined;
    let child;
    try {
      if (existing && !(await stopVerifiedService(config, existing)))
        throw new Error("旧版后台状态已变化，请重新运行启动命令。");
      child = spawn(
        process.execPath,
        [process.argv[1], "ui", ...args, "--foreground", "--no-open"],
        {
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
          env: { ...process.env, SKILLS_CONSOLE_BACKGROUND: "1" },
        },
      );
      child.once("error", (error) => {
        failure = error;
      });
      child.unref();
    } finally {
      await log.close();
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      if (failure || child.exitCode !== null || child.signalCode !== null)
        break;
      const record = await runningService(config);
      if (record && record.pid === child.pid)
        return { record, reused: false, upgradedFrom: existing?.appVersion };
      await delay(100);
    }
    if (child.pid && child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    throw new Error(
      `后台服务启动失败，请查看 ${join(dirname(config), "service.log")}（端口可能已被占用）。`,
    );
  });
}

async function stopVerifiedService(config: string, expected: RunningService) {
  const record = await runningService(config);
  if (
    !record ||
    record.pid !== expected.pid ||
    record.instanceId !== expected.instanceId
  )
    return false;
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (errorCode(error) === "ESRCH") return true;
    throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(record.pid, 0);
      await readFile(servicePath(config), "utf8");
    } catch (error) {
      if (errorCode(error) === "ESRCH" || errorCode(error) === "ENOENT")
        return true;
      throw error;
    }
    await delay(100);
  }
  throw new Error("服务尚未停止，请稍后重新检查状态。");
}

export async function stopService(config: string) {
  return withServiceLock(config, async () => {
    const record = await runningService(config);
    return record ? stopVerifiedService(config, record) : false;
  });
}
