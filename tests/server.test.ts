import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server/index.js";

let fixture: string;
let home: string;
const token = "test-token-for-isolated-session";
const headers = { host: "127.0.0.1", authorization: `Bearer ${token}` };
const servers: Awaited<ReturnType<typeof createServer>>[] = [];
async function server(extra = {}) {
  const s = await createServer({ home, token, ...extra });
  servers.push(s);
  return s.app;
}
beforeEach(async () => {
  fixture = await realpath(
    await mkdtemp(join(tmpdir(), "skills-console-api-")),
  );
  home = join(fixture, "home");
  await mkdir(home);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.app.close()));
  await rm(fixture, { recursive: true, force: true });
});

describe("loopback session boundary", () => {
  it("does not relabel custom global roots as project installations", async () => {
    const root = join(fixture, "custom-global");
    const project = join(fixture, "project");
    await mkdir(join(root, "global-only"), { recursive: true });
    await mkdir(project);
    await writeFile(
      join(root, "global-only/SKILL.md"),
      "---\nname: global-only\ndescription: Global only\n---\n# Global\n",
    );
    const app = await server({
      projects: [project],
      additionalRoots: [{ path: root, tool: "custom" }],
    });
    const state = (await app.inject({ url: "/api/state", headers })).json();
    const global = (
      await app.inject({ url: "/api/inventory", headers })
    ).json();
    const local = (
      await app.inject({
        url: `/api/inventory?scope=${state.projects[0].id}`,
        headers,
      })
    ).json();
    expect(global.installations).toHaveLength(1);
    expect(local.installations).toHaveLength(0);
  });
  it("does not overwrite a project configuration changed after startup", async () => {
    const configPath = join(fixture, "config.json");
    const app = await server({ configPath });
    const project = join(fixture, "project");
    await mkdir(project);
    const external = JSON.stringify({
      version: 1,
      projects: [{ path: "/other/project" }],
    });
    await writeFile(configPath, external);
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { path: project },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toContain("其他进程修改");
    expect(await readFile(configPath, "utf8")).toBe(external);
  });
  it("requires a session, loopback host and same-origin requests", async () => {
    const app = await server();
    expect(
      (await app.inject({ url: "/api/state", headers: { host: "127.0.0.1" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { ...headers, host: "evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { ...headers, origin: "https://evil.example" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: "/api/state",
          headers: { ...headers, "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({ url: "/api/state", headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json().home).toBe(home);
  });

  it("registers projects persistently without creating or editing their files", async () => {
    const configPath = join(fixture, "config/config.json");
    const project = join(fixture, "my-project");
    await mkdir(project);
    const app = await server({ configPath });
    const result = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers,
      payload: { path: project },
    });
    expect(result.statusCode).toBe(200);
    const registered = result.json();
    expect(registered.path).toBe(project);
    expect(
      (await app.inject({ url: "/api/state", headers })).json().projects,
    ).toHaveLength(1);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { path: project },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/state", headers })).json().projects,
    ).toHaveLength(1);
    expect(JSON.parse(await readFile(configPath, "utf8")).projects).toEqual([
      { path: project },
    ]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { path: home },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { path: "./relative" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          url: `/api/inventory?scope=${registered.id}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("returns details only for observed installations in registered scopes", async () => {
    const root = join(home, ".agents/skills/example");
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "SKILL.md"),
      "---\nname: example\ndescription: example\n---\n# Hello\n<script>alert(1)</script>",
    );
    const app = await server();
    const inventory = (
      await app.inject({ url: "/api/inventory", headers })
    ).json();
    expect(inventory.installations).toHaveLength(1);
    const id = inventory.installations[0].id;
    const detail = await app.inject({ url: `/api/skills/${id}`, headers });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().markdown).toContain("# Hello");
    expect(
      (await app.inject({ url: "/api/skills/not-observed", headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: "/api/inventory?scope=/etc", headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/skills/${id}?scope=not-registered`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
  });

  it("preserves invalid project configuration and reports it rather than overwriting", async () => {
    const configPath = join(fixture, "config.json");
    await writeFile(configPath, "{broken config");
    const project = join(fixture, "project");
    await mkdir(project);
    const app = await server({ configPath });
    expect(
      (await app.inject({ url: "/api/state", headers })).json().configIssue,
    ).toBeTruthy();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers,
          payload: { path: project },
        })
      ).statusCode,
    ).toBe(400);
    expect(await readFile(configPath, "utf8")).toBe("{broken config");
  });
});
