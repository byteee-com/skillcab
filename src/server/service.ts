import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ServiceRecord {
  version: 1;
  pid: number;
  url: string;
  instanceId: string;
}
export const servicePath = (config: string) =>
  join(dirname(config), "service.json");
export async function runningService(
  config: string,
): Promise<ServiceRecord | undefined> {
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
      url.username ||
      url.password
    )
      return;
    const response = await fetch(`${record.url}api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const health = (await response.json()) as {
      app?: string;
      instanceId?: string;
      pid?: number;
    };
    if (
      response.ok &&
      health.app === "skills-console" &&
      health.instanceId === record.instanceId &&
      health.pid === record.pid
    )
      return record;
  } catch {
    /* A stale record is never sufficient to signal a process. */
  }
}
export async function startBackground(
  config: string,
  args: string[],
): Promise<{ record: ServiceRecord; reused: boolean }> {
  await mkdir(dirname(config), { recursive: true, mode: 0o700 });
  const lockPath = `${servicePath(config)}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch {
    throw new Error(
      `另一个启动正在进行；若上次启动意外中断，请删除 ${lockPath} 后重试。`,
    );
  }
  try {
    const existing = await runningService(config);
    if (existing) return { record: existing, reused: true };
    const log = await open(join(dirname(config), "service.log"), "a", 0o600);
    let failure: Error | undefined;
    let child;
    try {
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
      if (failure || child.exitCode !== null) break;
      const record = await runningService(config);
      if (record && record.pid === child.pid) return { record, reused: false };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
    throw new Error(
      `后台服务启动失败，请查看 ${join(dirname(config), "service.log")}（端口可能已被占用）。`,
    );
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
export async function stopService(config: string) {
  const record = await runningService(config);
  if (!record) return false;
  process.kill(record.pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!(await runningService(config))) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务尚未停止，请稍后重新检查状态。");
}
