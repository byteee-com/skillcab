import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../dist/server.js";

const fixture = await realpath(
  await mkdtemp(join(tmpdir(), "skills-console-package-")),
);
let app;
try {
  const home = join(fixture, "home");
  const project = join(fixture, "project");
  const skill = join(home, ".agents/skills/package-smoke");
  await mkdir(skill, { recursive: true });
  await mkdir(project);
  const document =
    "---\nname: package-smoke\ndescription: Package smoke fixture\n---\n# Packaged document\n";
  await writeFile(join(skill, "SKILL.md"), document);
  const cli = execFileSync(
    process.execPath,
    ["dist/cli.js", "list", "--home", home, "--json"],
    { encoding: "utf8" },
  );
  const list = JSON.parse(cli);
  assert.equal(list.installations.length, 1);
  const result = await createServer({
    home,
    projects: [project],
  });
  app = result.app;
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const html = await fetch(address).then((r) => r.text());
  assert.ok(html.includes("skillcab"));
  const script = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(script, "Compiled web script is referenced");
  const asset = await fetch(`${address}${script}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.equal((await fetch(`${address}/api/state`)).status, 200);
  const headers = { "x-skills-console": "1" };
  const inventory = await fetch(`${address}/api/inventory`, { headers }).then(
    (r) => r.json(),
  );
  const detail = await fetch(
    `${address}/api/skills/${inventory.installations[0].id}`,
    { headers },
  ).then((r) => r.json());
  assert.match(detail.markdown, /Packaged document/);
  assert.equal(await readFile(join(skill, "SKILL.md"), "utf8"), document);
  console.log(
    "Package smoke passed: CLI JSON, loopback server, bundled UI, direct local details, read-only content.",
  );
} finally {
  await app?.close();
  await rm(fixture, { recursive: true, force: true });
}

// The launching terminal exits; the detached process stays usable, is reused, and stops cleanly.
const background = await realpath(
  await mkdtemp(join(tmpdir(), "skills-console-service-")),
);
const isolatedHome = join(background, "home");
const config = join(background, "config.json");
await mkdir(isolatedHome);
const cliArgs = [
  "dist/cli.js",
  "ui",
  "--home",
  isolatedHome,
  "--config",
  config,
  "--port",
  "0",
  "--no-open",
];
const { promisify } = await import("node:util");
const { execFile } = await import("node:child_process");
const run = promisify(execFile);
const command = (args) =>
  run(process.execPath, args, { cwd: process.cwd(), timeout: 20000 });
let legacy;
try {
  const first = await command(cliArgs);
  assert.match(first.stdout, /后台服务/);
  assert.ok(!first.stdout.includes("token="));
  const record = JSON.parse(
    await readFile(join(background, "service.json"), "utf8"),
  );
  const response = await fetch(`${record.url}api/state`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).home, isolatedHome);
  const second = await command(cliArgs);
  assert.match(second.stdout, /已连接现有/);
  assert.equal(
    JSON.parse(await readFile(join(background, "service.json"), "utf8")).pid,
    record.pid,
  );
  const status = await command(["dist/cli.js", "status", "--config", config]);
  assert.match(status.stdout, new RegExp(String(record.pid)));
  const checked = await command([
    "dist/cli.js",
    "check",
    "--home",
    isolatedHome,
    "--config",
    config,
    "--json",
  ]);
  assert.equal(JSON.parse(checked.stdout).scope.kind, "global");
  const stopped = await command(["dist/cli.js", "stop", "--config", config]);
  assert.match(stopped.stdout, /已停止/);
  if (process.platform !== "win32") {
    const oldProject = join(background, "old-project");
    const oldRoot = join(background, "custom-root");
    const statePath = join(background, "service.json");
    await Promise.all([mkdir(oldProject), mkdir(oldRoot)]);
    legacy = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { createServer } from "node:http";
       import { rm, writeFile } from "node:fs/promises";
       const [record, home, project, root] = process.argv.slice(1);
       const health = { app: "skills-console", version: "0.3.1", pid: process.pid, instanceId: "legacy" };
       const responses = {
         "/api/health": health,
         "/api/state": { home, projects: [{ path: project }] },
         "/api/inventory?scope=global": { roots: [{ path: root, tool: "custom" }] },
       };
       const server = createServer((req, res) => res.end(JSON.stringify(responses[req.url])));
       server.listen(0, "127.0.0.1", async () => {
         const url = "http://127.0.0.1:" + server.address().port + "/";
         await writeFile(record, JSON.stringify({ version: 1, pid: process.pid, instanceId: "legacy", url }));
         process.send(url);
       });
       process.on("SIGTERM", () => server.close(async () => {
         await rm(record);
         process.exit(0);
       }));`,
        statePath,
        isolatedHome,
        oldProject,
        oldRoot,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    const oldUrl = await new Promise((resolve, reject) => {
      legacy.once("message", resolve);
      legacy.once("error", reject);
      legacy.once("exit", (code) =>
        reject(new Error(`旧服务测试进程提前退出（${code}）`)),
      );
    });
    const upgrade = () =>
      command(["dist/cli.js", "ui", "--config", config, "--no-open"]);
    const results = await Promise.all([upgrade(), upgrade()]);
    assert.equal(
      results.filter((result) => /已从 v0\.3\.1 升级/.test(result.stdout))
        .length,
      1,
    );
    assert.equal(
      results.filter((result) => /已连接现有/.test(result.stdout)).length,
      1,
    );
    const upgraded = JSON.parse(await readFile(statePath, "utf8"));
    assert.notEqual(upgraded.pid, legacy.pid);
    assert.equal(upgraded.url, oldUrl);
    const state = await fetch(`${oldUrl}api/state`).then((response) =>
      response.json(),
    );
    assert.equal(state.home, isolatedHome);
    assert.ok(state.projects.some((project) => project.path === oldProject));
    assert.deepEqual(upgraded.roots, [oldRoot]);
    await command(["dist/cli.js", "stop", "--config", config]);
  }
  // A stale PID file must not signal an unrelated process, even if its PID is live.
  await writeFile(
    join(background, "service.json"),
    JSON.stringify({ ...record, pid: process.pid, instanceId: "stale" }),
  );
  const stale = await command(["dist/cli.js", "stop", "--config", config]);
  assert.match(stale.stdout, /没有正在运行/);
  console.log(
    "Background smoke passed: detached launch, reuse, upgrade, status, CLI check, stop, stale PID protection.",
  );
} finally {
  await command(["dist/cli.js", "stop", "--config", config]).catch(
    () => undefined,
  );
  if (legacy?.exitCode === null && legacy.signalCode === null)
    legacy.kill("SIGTERM");
  await rm(background, { recursive: true, force: true });
}
