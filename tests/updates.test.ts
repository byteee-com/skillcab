import { beforeEach, afterEach, describe, it, expect } from "vitest";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SkillOperations } from "../src/core/operations.js";
import { VersionService } from "../src/core/updates.js";
import { scanSkills } from "../src/core/scanner.js";
import { contentHash, resolveSkillsSource } from "../src/core/sources.js";
import { createServer } from "../src/server/index.js";
import type { Installation } from "../src/core/types.js";
let fixture: string,
  home: string,
  source: string,
  skill: string,
  project: string,
  service: VersionService;
const doc = (name = "example", version = "1.0.0") =>
  `---\nname: ${name}\ndescription: Example\nmetadata:\n  version: "${version}"\n---\n# Example\n`;
async function file(path: string, text: string) {
  await writeFile(path, text);
}
beforeEach(async () => {
  fixture = await realpath(
    await mkdtemp(join(tmpdir(), "skills-console-updates-")),
  );
  home = join(fixture, "home");
  source = join(fixture, "source");
  project = join(fixture, "project");
  skill = join(home, ".codex/skills/example");
  for (const path of [skill, source, project])
    await mkdir(path, { recursive: true });
  await file(join(skill, "SKILL.md"), doc());
  await file(join(source, "SKILL.md"), doc());
  service = new VersionService(join(fixture, "versions.json"), home);
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});
const inventory = () => scanSkills({ home });
const current = async () => (await inventory()).installations[0];
describe("version evidence and update checks", () => {
  it("does not infer versions or fetch untracked skills during a scan", async () => {
    const result = await service.decorate(await inventory());
    expect(result.installations[0].update?.status).toBe("untracked");
    await expect(readFile(service.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await service.check(result);
    expect(result.installations[0].update?.status).toBe("untracked");
  });
  it("keeps broken links visible when no source registration exists", async () => {
    await symlink(join(fixture, "missing"), join(home, ".codex/skills/broken"));
    const result = await service.decorate(await inventory());
    expect(result.installations).toHaveLength(2);
    expect(result.installations.find((i) => !i.realPath)?.update?.status).toBe(
      "untracked",
    );
  });
  it("does not reuse a manual source when a directory at the same path is replaced", async () => {
    await service.register(await current(), source);
    await rename(skill, `${skill}-old`);
    await mkdir(skill);
    await file(join(skill, "SKILL.md"), doc());
    const result = await service.decorate(await inventory());
    const replacement = result.installations.find(
      (item) => item.realPath === skill,
    )!;
    expect(replacement.tracking).toBeUndefined();
    expect(replacement.update?.status).toBe("untracked");
  });
  it("keeps mismatched manual history unknown and expires cached checks", async () => {
    await file(join(source, "SKILL.md"), doc("example", "2.0.0"));
    await service.register(await current(), source);
    let result = await service.check(await inventory());
    expect(result.installations[0].tracking?.baseline).toBeUndefined();
    expect(result.installations[0].update).toMatchObject({
      status: "unknown",
      localState: "unknown",
    });
    const stored = JSON.parse(await readFile(service.path, "utf8"));
    stored.checks[result.installations[0].id].result.checkedAt =
      "2000-01-01T00:00:00.000Z";
    await file(service.path, JSON.stringify(stored));
    result = await service.decorate(await inventory());
    expect(result.installations[0].update?.status).toBe("unchecked");
    await file(join(source, "SKILL.md"), doc());
    result = await service.check(await inventory());
    expect(result.installations[0].update?.status).toBe("current");
    expect(result.installations[0].tracking?.baseline).toBeUndefined();
  });
  it("registers verified manual sources, persists baselines and detects upstream and local changes independently", async () => {
    const item = await current();
    const before = await readFile(join(skill, "SKILL.md"), "utf8");
    await service.register(item, source);
    const reload = new VersionService(service.path, home);
    let result = await reload.check(await inventory());
    expect(result.installations[0].tracking?.baseline?.hash).toBe(
      await contentHash(skill, 2),
    );
    expect(result.installations[0].update).toMatchObject({
      status: "current",
      localState: "clean",
      upstreamVersion: "1.0.0",
    });
    await file(join(source, "SKILL.md"), doc("example", "2.0.0"));
    result = await reload.check(await inventory());
    expect(result.installations[0].update).toMatchObject({
      status: "available",
      localState: "clean",
      upstreamVersion: "2.0.0",
    });
    expect(
      (await reload.decorate(await inventory())).installations[0].update
        ?.status,
    ).toBe("available");
    await file(join(skill, "custom.txt"), "user edit");
    expect(
      (await reload.decorate(await inventory())).installations[0].update
        ?.status,
    ).toBe("unchecked");
    result = await reload.check(await inventory());
    expect(result.installations[0].update).toMatchObject({
      status: "available",
      localState: "modified",
    });
    expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe(before);
    await reload.remove(item);
    expect(
      (await reload.decorate(await inventory())).installations[0].tracking,
    ).toBeUndefined();
  });
  it("keeps a mismatching manual source baseline unknown instead of blessing the current content", async () => {
    await file(join(skill, "user.txt"), "custom");
    await service.register(await current(), source);
    let result = await service.check(await inventory());
    expect(result.installations[0].tracking?.baseline).toBeUndefined();
    expect(result.installations[0].update?.status).toBe("unknown");
    await rm(join(skill, "user.txt"));
    result = await service.check(await inventory());
    expect(result.installations[0].update?.status).toBe("current");
    expect(result.installations[0].tracking?.baseline).toBeUndefined();
  });
  it.each([1, 2])(
    "reads npx project schema %i with exact content hashes and keeps scopes isolated",
    async (version) => {
      const installed = join(project, ".agents/skills/example");
      await mkdir(installed, { recursive: true });
      await file(join(installed, "SKILL.md"), doc());
      const lock = JSON.stringify({
        version,
        skills: {
          example: {
            source,
            sourceType: "local",
            computedHash: await contentHash(installed, version),
          },
        },
      });
      await file(join(project, "skills-lock.json"), lock);
      let result = await service.check(await scanSkills({ home, project }));
      expect(result.installations[0].update?.status).toBe("current");
      await file(join(source, "extra.txt"), "upstream changed");
      result = await service.check(await scanSkills({ home, project }));
      expect(result.installations[0].update).toMatchObject({
        status: "available",
        localState: "clean",
      });
      expect(
        (await service.decorate(await inventory())).installations[0].update
          ?.status,
      ).toBe("untracked");
      expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(
        lock,
      );
    },
  );
  it("checks content baselines written by the console for non-GitHub global installations", async () => {
    const manager = new SkillOperations(
      join(fixture, "operations"),
      () => ({ home }),
      () => [{ home }],
    );
    try {
      const catalog = await manager.resolve(source, undefined, "global");
      await manager.apply(
        (await manager.previewInstall(catalog.id, "example", ["cursor"])).id,
      );
      await file(join(source, "SKILL.md"), doc("example", "2.0.0"));
      const result = await service.check(await inventory());
      const item = result.installations.find((i) => i.provenance)!;
      expect(item.provenance?.hash?.algorithm).toBe("skills-content-v2");
      expect(item.update).toMatchObject({
        status: "available",
        localState: "clean",
      });
    } finally {
      await manager.close();
    }
  });
  it("compares GitHub folder tree evidence, ignoring unrelated repository commits", async () => {
    const git = promisify(execFile);
    const run = (args: string[]) =>
      git("git", args, { cwd: source }).then((r) => r.stdout.trim());
    await run(["init", "-b", "main"]);
    await run(["config", "user.name", "Fixture"]);
    await run(["config", "user.email", "fixture@example.test"]);
    await run(["add", "."]);
    await run(["commit", "-m", "initial"]);
    const commit = await run(["rev-parse", "HEAD"]);
    const tree = await run(["rev-parse", "HEAD^{tree}"]);
    const installed = join(home, ".agents/skills/example");
    await mkdir(installed, { recursive: true });
    await file(join(installed, "SKILL.md"), doc());
    await file(
      join(home, ".agents/.skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          example: {
            source: "owner/repo",
            sourceType: "github",
            skillFolderHash: tree,
            ref: "main",
            commit,
            skillPath: "SKILL.md",
          },
        },
      }),
    );
    // Real Git objects, isolated local resolution: the same tree-lookup contract as fetched repositories.
    const resolver: typeof resolveSkillsSource = async () => {
      const prepared = await resolveSkillsSource(source, undefined, home, home);
      return {
        ...prepared,
        info: { ...prepared.info, commit: await run(["rev-parse", "HEAD"]) },
        treeHash: () => run(["rev-parse", "HEAD^{tree}"]),
      };
    };
    const versions = new VersionService(service.path, home, resolver);
    let result = await versions.check(await inventory());
    expect(result.installations.find((i) => i.provenance)?.update?.status).toBe(
      "current",
    );
    await run(["commit", "--allow-empty", "-m", "unrelated"]);
    result = await versions.check(await inventory());
    expect(result.installations.find((i) => i.provenance)?.update?.status).toBe(
      "current",
    );
    await file(join(source, "SKILL.md"), doc("example", "2.0.0"));
    await run(["add", "."]);
    await run(["commit", "-m", "skill update"]);
    result = await versions.check(await inventory());
    expect(result.installations.find((i) => i.provenance)?.update?.status).toBe(
      "available",
    );
  });
  it("checks renamed npx project installs without changing unrelated frontmatter formatting", async () => {
    const original =
      '---\r\nname: original # upstream comment\r\ndescription: Example\r\nmetadata: { version: "1.0.0" }\r\n---\r\n# Kept\r\n';
    const renamed = original.replace(
      "name: original # upstream comment",
      "name: renamed",
    );
    await file(join(source, "SKILL.md"), original);
    const installed = join(project, ".agents/skills/renamed");
    await mkdir(installed, { recursive: true });
    await file(join(installed, "SKILL.md"), renamed);
    await file(
      join(project, "skills-lock.json"),
      JSON.stringify({
        version: 2,
        skills: {
          renamed: {
            source,
            sourceType: "local",
            skillName: "original",
            computedHash: await contentHash(installed, 2),
          },
        },
      }),
    );
    const result = await service.check(await scanSkills({ home, project }));
    expect(result.installations[0].update).toMatchObject({
      status: "current",
      localState: "clean",
    });
    expect(await readFile(join(installed, "SKILL.md"), "utf8")).toBe(renamed);
  });
  it("keeps failed checks visible and never replaces corrupt metadata or follows resource links", async () => {
    await service.register(await current(), source);
    await rm(source, { recursive: true });
    let result = await service.check(await inventory());
    expect(result.installations[0].update?.status).toBe("error");
    expect(
      (await service.decorate(await inventory())).installations[0].update
        ?.status,
    ).toBe("error");
    await symlink(join(skill, "SKILL.md"), join(skill, "link.md"));
    result = await service.check(await inventory());
    expect(result.installations[0].update?.status).toBe("error");
    await file(service.path, "broken");
    expect(
      (await service.decorate(await inventory())).diagnostics[0].code,
    ).toBe("VERSIONS_UNREADABLE");
    await expect(service.remove(await current())).rejects.toThrow("版本记录");
    expect(await readFile(service.path, "utf8")).toBe("broken");
  });
  it("requires explicit child paths for ambiguous names and refuses paths outside the source", async () => {
    await rm(join(source, "SKILL.md"));
    for (const name of ["a", "b"]) {
      await mkdir(join(source, name));
      await file(join(source, name, "SKILL.md"), doc());
    }
    await expect(service.register(await current(), source)).rejects.toThrow(
      "唯一定位",
    );
    await expect(
      service.register(await current(), source, undefined, "../a"),
    ).rejects.toThrow("相对路径");
    await service.register(await current(), source, undefined, "a/SKILL.md");
    const result = await service.check(await inventory());
    expect(result.installations[0].tracking?.skillPath).toBe("a");
    expect(result.installations[0].update?.status).toBe("current");
  });
  it("exposes direct local APIs for registering, checking and removing sources without editing skills", async () => {
    const { app } = await createServer({
      home,
      configPath: join(fixture, "config.json"),
    });
    const headers = { host: "127.0.0.1", "x-skills-console": "1" };
    try {
      const state = await app.inject({
        url: "/api/state",
        headers: { host: "127.0.0.1" },
      });
      expect(state.statusCode).toBe(200);
      const id = (await current()).id;
      const origin = await app.inject({
        method: "PUT",
        url: `/api/skills/${id}/source`,
        headers,
        payload: { source },
      });
      expect(origin.statusCode).toBe(200);
      expect(origin.json().tracking.baseline).toBeTruthy();
      const check = await app.inject({
        method: "POST",
        url: `/api/skills/${id}/check`,
        headers,
      });
      expect(check.statusCode).toBe(200);
      expect(check.json().update.status).toBe("current");
      const all = await app.inject({
        method: "POST",
        url: "/api/updates/check",
        headers,
      });
      expect(all.statusCode).toBe(200);
      expect(
        (all.json().installations as Installation[])[0].update?.status,
      ).toBe("current");
      const remove = await app.inject({
        method: "DELETE",
        url: `/api/skills/${id}/source`,
        headers,
      });
      expect(remove.statusCode).toBe(200);
      expect(remove.json().tracking).toBeUndefined();
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/updates/check",
            headers: { host: "127.0.0.1", origin: "https://bad.test" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/skills/unknown/source",
            headers,
            payload: { source },
          })
        ).statusCode,
      ).toBe(400);
      expect(await readFile(join(skill, "SKILL.md"), "utf8")).toBe(doc());
    } finally {
      await app.close();
    }
  });
});

it("matches published npx skills v2 hash vectors and keeps legacy exclusions separate", async () => {
  const root = join(fixture, "hash-vectors");
  await mkdir(root);
  expect(await contentHash(root, 2)).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  await file(join(root, "SKILL.md"), "# hi\r\n");
  expect(await contentHash(root, 2)).toBe(
    "93c36952d8843b33e68ae970ebabcc03e1687c9bb0dd1ecaf357060318952f55",
  );
  await file(join(root, "metadata.json"), "ignored by v2 only");
  expect(await contentHash(root, 2)).toBe(
    "93c36952d8843b33e68ae970ebabcc03e1687c9bb0dd1ecaf357060318952f55",
  );
  const legacy = await contentHash(root, 1);
  await file(join(root, "metadata.json"), "changed");
  expect(await contentHash(root, 1)).not.toBe(legacy);
  await mkdir(join(root, "node_modules"));
  await file(join(root, "node_modules/resource.txt"), "v2 includes this");
  expect(await contentHash(root, 2)).not.toBe(
    "93c36952d8843b33e68ae970ebabcc03e1687c9bb0dd1ecaf357060318952f55",
  );
});
