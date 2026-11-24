import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "../src/server/index.js";

let fixture: string;
let home: string;
const headers = { host: "127.0.0.1", "x-skills-console": "1" };
const servers: Awaited<ReturnType<typeof createServer>>[] = [];
async function server(extra = {}) {
  const s = await createServer({ home, ...extra });
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
  it("allows direct local access and rejects foreign hosts and origins", async () => {
    const app = await server();
    expect(
      (await app.inject({ url: "/api/state", headers: { host: "127.0.0.1" } }))
        .statusCode,
    ).toBe(200);
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

  it("registers a batch once per real directory and rejects invalid batches without writing", async () => {
    const configPath = join(fixture, "config.json");
    const first = join(fixture, "project one");
    const second = join(fixture, "project-two");
    const alias = join(fixture, "alias");
    const file = join(fixture, "file.txt");
    await Promise.all([mkdir(first), mkdir(second), writeFile(file, "sample")]);
    await symlink(first, alias, "dir");
    const app = await server({ configPath });
    const add = (paths: string[]) =>
      app.inject({
        method: "POST",
        url: "/api/projects/batch",
        headers,
        payload: { paths },
      });
    const invalid = await add([first, file]);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toContain(file);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const valid = await add([alias, first, second]);
    expect(valid.statusCode).toBe(200);
    expect(valid.json().map((item: { path: string }) => item.path)).toEqual([
      first,
      second,
    ]);
    expect((await add([second, first])).statusCode).toBe(200);
    expect(JSON.parse(await readFile(configPath, "utf8")).projects).toEqual([
      { path: first },
      { path: second },
    ]);
  });

  it("uses paths chosen by the local folder dialog and leaves cancelled picks untouched", async () => {
    const configPath = join(fixture, "config.json");
    const first = join(fixture, "project one");
    const second = join(fixture, "project-two");
    await Promise.all([mkdir(first), mkdir(second)]);
    let selections: string[] = [];
    let calls = 0;
    const app = await server({
      configPath,
      pickProjectFolders: async () => {
        calls++;
        return selections;
      },
    });
    const request = { method: "POST" as const, url: "/api/projects/pick" };
    const crossSite = await app.inject({
      ...request,
      headers: { ...headers, origin: "https://example.invalid" },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(calls).toBe(0);
    expect((await app.inject({ ...request, headers })).json()).toEqual([]);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    selections = [first, second];
    expect((await app.inject({ ...request, headers })).json()).toHaveLength(2);
    expect(JSON.parse(await readFile(configPath, "utf8")).projects).toEqual([
      { path: first },
      { path: second },
    ]);
  });

  it("registers only a fresh Finder drop matching the browser's whole folder batch", async () => {
    const configPath = join(fixture, "config.json");
    const first = join(fixture, "one");
    const second = join(fixture, "二");
    await Promise.all([mkdir(first), mkdir(second)]);
    let changeCount = "10";
    let reads = 0;
    const app = await server({
      configPath,
      readFinderDrag: async (includePaths: boolean) => {
        reads++;
        return {
          changeCount,
          paths: includePaths ? [second, first] : undefined,
        };
      },
    });
    const snapshot = await app.inject({
      method: "POST",
      url: "/api/projects/drop/snapshot",
      headers,
    });
    expect(snapshot.json()).toEqual({ changeCount: "10" });
    const drop = (names: string[], origin?: string) =>
      app.inject({
        method: "POST",
        url: "/api/projects/drop",
        headers: origin ? { ...headers, origin } : headers,
        payload: { before: "10", names },
      });
    expect(
      (await drop(["one", "二"], "https://unrelated.invalid")).statusCode,
    ).toBe(403);
    expect(reads).toBe(1);
    expect((await drop(["one", "二"])).statusCode).toBe(409);
    changeCount = "11";
    expect((await drop(["one"])).statusCode).toBe(409);
    expect((await drop(["one", "other"])).statusCode).toBe(409);
    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await drop(["one", "二"]))
        .json()
        .projects.map((item: { path: string }) => item.path),
    ).toEqual([second, first]);
    expect((await drop(["one", "二"])).statusCode).toBe(409);
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
