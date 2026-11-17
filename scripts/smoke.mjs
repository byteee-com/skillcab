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
    token: "package-smoke-token",
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
  assert.equal((await fetch(`${address}/api/state`)).status, 401);
  const headers = { authorization: "Bearer package-smoke-token" };
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
    "Package smoke passed: CLI JSON, loopback server, bundled UI, authenticated details, read-only content.",
  );
} finally {
  await app?.close();
  await rm(fixture, { recursive: true, force: true });
}
