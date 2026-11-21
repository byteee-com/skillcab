import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  assert.ok(html.includes("Skills Console"));
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
  // A stale PID file must not signal an unrelated process, even if its PID is live.
  await writeFile(
    join(background, "service.json"),
    JSON.stringify({ ...record, pid: process.pid, instanceId: "stale" }),
  );
  const stale = await command(["dist/cli.js", "stop", "--config", config]);
  assert.match(stale.stdout, /没有正在运行/);
  console.log(
    "Background smoke passed: parent exits, plain URL, reuse, status, CLI check, stop, stale PID protection.",
  );
} finally {
  await command(["dist/cli.js", "stop", "--config", config]).catch(
    () => undefined,
  );
  await rm(background, { recursive: true, force: true });
}
