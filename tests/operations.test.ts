import { beforeEach, afterEach, describe, it, expect } from "vitest";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readdir,
  lstat,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillOperations } from "../src/core/operations.js";
import { scanSkills } from "../src/core/scanner.js";
import { contentHash, resolveSkillsSource } from "../src/core/sources.js";
import type { ScanOptions } from "../src/core/types.js";
import { createServer } from "../src/server/index.js";
import { createServer as netServer } from "node:net";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

let fixture: string,
  home: string,
  project: string,
  source: string,
  manager: SkillOperations;
const document =
  "---\nname: test-skill\ndescription: A test skill\n---\n# Test\n";
const options = (scope = "global"): ScanOptions => ({
  home,
  project: scope === "global" ? undefined : project,
});
beforeEach(async () => {
  fixture = await realpath(
    await mkdtemp(join(tmpdir(), "skills-console-operations-")),
  );
  home = join(fixture, "home");
  project = join(fixture, "project");
  source = join(fixture, "source");
  for (const dir of [home, project, source]) await mkdir(dir);
  await writeFile(join(source, "SKILL.md"), document);
  await writeFile(join(source, "helper.sh"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  manager = new SkillOperations(join(fixture, "operations"), options, () => [
    options(),
    options("project"),
  ]);
});
afterEach(async () => {
  await manager.close();
  await rm(fixture, { recursive: true, force: true });
});
async function preview(scope = "global") {
  const catalog = await manager.resolve(source, undefined, scope);
  return manager.previewInstall(catalog.id, "test-skill", [
    "codex",
    "claude-code",
  ]);
}
const missing = (path: string) =>
  lstat(path).then(
    () => false,
    () => true,
  );

describe("explicit installation operations", () => {
  it("prepares without writes, installs a fixed snapshot, and preserves unrelated lock records", async () => {
    await mkdir(join(home, ".agents"));
    await writeFile(
      join(home, ".agents/.skill-lock.json"),
      JSON.stringify({
        version: 3,
        unknown: "keep",
        skills: { unrelated: { source: "other/repo", unknown: 9 } },
      }),
    );
    const plan = await preview();
    expect(await missing(join(home, ".agents/skills/test-skill"))).toBe(true);
    await writeFile(
      join(source, "SKILL.md"),
      document + "changed after preview",
    );
    const result = await manager.apply(plan.id);
    const canonical = join(home, ".agents/skills/test-skill");
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(document);
    expect(
      (await lstat(join(canonical, "helper.sh"))).mode & 0o111,
    ).toBeTruthy();
    expect(await realpath(join(home, ".claude/skills/test-skill"))).toBe(
      canonical,
    );
    const lock = JSON.parse(
      await readFile(join(home, ".agents/.skill-lock.json"), "utf8"),
    );
    expect(lock.unknown).toBe("keep");
    expect(lock.skills.unrelated.unknown).toBe(9);
    expect(lock.skills["test-skill"].sourceType).toBe("local");
    expect(
      (await scanSkills(options())).installations.find(
        (i) => i.name === "test-skill",
      )?.manager,
    ).toBe("skills-cli");
    expect(result.scopeId).toBe("global");
    await expect(manager.apply(plan.id)).rejects.toThrow(/已执行/);
  });
  it.each([1, 2])(
    "preserves project lock schema %i and computes its matching content hash",
    async (version) => {
      await writeFile(
        join(project, "skills-lock.json"),
        JSON.stringify({ version, skills: {}, unknown: true }),
      );
      const plan = await preview("project");
      await manager.apply(plan.id);
      const lock = JSON.parse(
        await readFile(join(project, "skills-lock.json"), "utf8"),
      );
      expect(lock.version).toBe(version);
      expect(lock.unknown).toBe(true);
      expect(lock.skills["test-skill"].computedHash).toBe(
        await contentHash(join(project, ".agents/skills/test-skill"), version),
      );
      expect(await readdir(home)).toEqual([]);
    },
  );
  it("rejects collisions and local or lock changes after preview", async () => {
    const first = await preview();
    await mkdir(join(home, ".agents/skills/test-skill"), { recursive: true });
    await writeFile(
      join(home, ".agents/skills/test-skill/keep.txt"),
      "user data",
    );
    await expect(manager.apply(first.id)).rejects.toThrow(/变化/);
    expect(
      await readFile(join(home, ".agents/skills/test-skill/keep.txt"), "utf8"),
    ).toBe("user data");
    await expect(preview()).rejects.toThrow(/已存在/);
    const second = await preview("project");
    await writeFile(
      join(project, "skills-lock.json"),
      '{"version":2,"skills":{}}',
    );
    await expect(manager.apply(second.id)).rejects.toThrow(/锁文件/);
    expect(await missing(join(project, ".agents/skills/test-skill"))).toBe(
      true,
    );
  });
  it("rejects symlink resources and unsupported lock schemas without modifying either source or destination", async () => {
    await symlink(join(source, "SKILL.md"), join(source, "linked.md"));
    await expect(preview()).rejects.toThrow(/软链接/);
    expect(await readdir(home)).toEqual([]);
    await rm(join(source, "linked.md"));
    await writeFile(
      join(project, "skills-lock.json"),
      '{"version":99,"skills":{}}',
    );
    await expect(preview("project")).rejects.toThrow(/格式/);
  });
});

describe("uninstall and recovery", () => {
  it("uninstalls the selected group, removes only its lock entry and supports undo", async () => {
    await manager.apply((await preview()).id);
    const lockPath = join(home, ".agents/.skill-lock.json"),
      before = await readFile(lockPath, "utf8");
    const item = (await scanSkills(options())).installations[0];
    const plan = await manager.previewUninstall("global", item.id);
    expect(
      await readFile(join(home, ".agents/skills/test-skill/SKILL.md"), "utf8"),
    ).toBe(document);
    const result = await manager.apply(plan.id);
    expect(result.undoAvailable).toBe(true);
    expect((await scanSkills(options())).installations).toHaveLength(0);
    expect(JSON.parse(await readFile(lockPath, "utf8")).skills).toEqual({});
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(document);
    await manager.undo(plan.id);
    expect(
      JSON.parse(
        await readFile(join(result.backupPath, "operation.json"), "utf8"),
      ).state,
    ).toBe("undone");
    expect(await readFile(lockPath, "utf8")).toBe(before);
    expect((await scanSkills(options())).installations).toHaveLength(1);
  });
  it("removes a manual link without traversing its source project", async () => {
    const root = join(project, ".codex/skills");
    await mkdir(root, { recursive: true });
    await symlink(source, join(root, "test-skill"), "dir");
    const item = (await scanSkills(options("project"))).installations[0];
    await manager.apply(
      (await manager.previewUninstall("project", item.id)).id,
    );
    expect(await missing(join(root, "test-skill"))).toBe(true);
    expect(await readFile(join(source, "SKILL.md"), "utf8")).toBe(document);
  });
  it("blocks removing shared content still referenced by another registered project", async () => {
    await manager.apply((await preview()).id);
    const root = join(project, ".codex/skills");
    await mkdir(root, { recursive: true });
    await symlink(
      join(home, ".agents/skills/test-skill"),
      join(root, "shared"),
      "dir",
    );
    const item = (await scanSkills(options())).installations[0];
    await expect(manager.previewUninstall("global", item.id)).rejects.toThrow(
      /其他位置/,
    );
    const linkIndex = item.locations.findIndex((l) => l.tool === "claude-code");
    await manager.apply(
      (await manager.previewUninstall("global", item.id, [linkIndex])).id,
    );
    expect(
      await readFile(join(home, ".agents/skills/test-skill/SKILL.md"), "utf8"),
    ).toBe(document);
    expect(
      JSON.parse(await readFile(join(home, ".agents/.skill-lock.json"), "utf8"))
        .skills["test-skill"],
    ).toBeTruthy();
  });
  it("does not overwrite a newly occupied path during undo", async () => {
    await manager.apply((await preview()).id);
    const item = (await scanSkills(options())).installations[0];
    const plan = await manager.previewUninstall("global", item.id);
    await manager.apply(plan.id);
    const path = join(home, ".agents/skills/test-skill");
    await mkdir(path);
    await writeFile(join(path, "user.txt"), "keep");
    await expect(manager.undo(plan.id)).rejects.toThrow(/占用/);
    expect(await readFile(join(path, "user.txt"), "utf8")).toBe("keep");
  });
});

it("authenticates mutation routes and opens only a freshly scanned directory", async () => {
  const opened: string[] = [];
  await mkdir(join(home, ".agents/skills"), { recursive: true });
  await symlink(source, join(home, ".agents/skills/linked"), "dir");
  const { app } = await createServer({
    home,
    token: "testing-operations",
    configPath: join(fixture, "config.json"),
    openDirectory: async (path) => {
      opened.push(path);
    },
  });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/operations/install/preview",
          headers: { host: "127.0.0.1" },
        })
      ).statusCode,
    ).toBe(401);
    const headers = {
      host: "127.0.0.1",
      authorization: "Bearer testing-operations",
    };
    const id = (await scanSkills(options())).installations[0].id;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/skills/${id}/open`,
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(opened).toEqual([source]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/skills/unknown/open",
          headers,
          payload: { path: "/etc" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/install/sources",
          headers,
          payload: { source, scope: "not-registered" },
        })
      ).statusCode,
    ).toBe(404);
  } finally {
    await app.close();
  }
});

it("fetches and installs a pinned Git source through the real Git protocol", async () => {
  const exec = promisify(execFile);
  const git = (args: string[]) =>
    exec("git", [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  await git(["init", "-b", "main", source]);
  await git(["-C", source, "config", "user.name", "Fixture"]);
  await git(["-C", source, "config", "user.email", "fixture@example.invalid"]);
  await git(["-C", source, "add", "."]);
  await git(["-C", source, "commit", "-m", "fixture"]);
  const sha = (await git(["-C", source, "rev-parse", "HEAD"])).stdout.trim();
  const remote = join(fixture, "remote");
  await mkdir(remote);
  await git(["clone", "--bare", source, join(remote, "repo.git")]);
  const socket = netServer();
  await new Promise<void>((r) => socket.listen(0, "127.0.0.1", r));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((r) => socket.close(() => r()));
  const daemon = spawn(
    "git",
    [
      "daemon",
      "--verbose",
      "--reuseaddr",
      "--export-all",
      `--base-path=${remote}`,
      "--listen=127.0.0.1",
      `--port=${port}`,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Git daemon did not start")),
        5000,
      );
      daemon.stderr.on("data", (data) => {
        if (String(data).includes("Ready to rumble")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      daemon.once("error", reject);
    });
    const catalog = await manager.resolve(
      `git://127.0.0.1:${port}/repo.git`,
      sha,
      "project",
    );
    const plan = await manager.previewInstall(catalog.id, "test-skill", [
      "codex",
    ]);
    await manager.apply(plan.id);
    const lock = JSON.parse(
      await readFile(join(project, "skills-lock.json"), "utf8"),
    );
    expect(lock.skills["test-skill"].commit).toBe(sha);
    expect(lock.skills["test-skill"].ref).toBe(sha);
  } finally {
    daemon.kill();
  }
});

it("rejects credential URLs and option-like refs before running Git", async () => {
  await expect(
    resolveSkillsSource(
      "https://user:password@github.com/a/b",
      undefined,
      project,
      home,
    ),
  ).rejects.toThrow(/凭据/);
  await expect(
    resolveSkillsSource(
      "https://github.com/a/b/tree/--upload-pack=evil/skill",
      undefined,
      project,
      home,
    ),
  ).rejects.toThrow(/格式/);
});
