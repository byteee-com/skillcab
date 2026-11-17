import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkillDetail, scanSkills } from "../src/core/scanner.js";

let fixture: string;
let home: string;
let project: string;
const skill = (name: string, body = "# Hello\n\nA useful skill.") =>
  `---\nname: ${name}\ndescription: Helps with ${name}\nmetadata:\n  version: "1.2.0"\n---\n${body}\n`;
async function file(path: string, body: string) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
}
async function install(root: string, name: string, content = skill(name)) {
  const path = join(root, name);
  await file(join(path, "SKILL.md"), content);
  return path;
}
beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), "skills-console-")));
  home = join(fixture, "home");
  project = join(fixture, "project");
  await mkdir(home);
  await mkdir(project);
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

describe("read-only filesystem inventory", () => {
  it("keeps documents readable when YAML metadata has cyclic aliases", async () => {
    await install(
      join(home, ".agents/skills"),
      "cyclic",
      "---\nname: cyclic\ndescription: Cyclic metadata\nmetadata: &a { self: *a }\n---\n# Still readable\n",
    );
    const result = await scanSkills({ home });
    const detail = await getSkillDetail(result.installations[0]);
    expect(detail.markdown).toContain("Still readable");
    expect(detail.diagnostics.map((d) => d.code)).toContain(
      "FRONTMATTER_INVALID",
    );
    expect(() => JSON.stringify(detail)).not.toThrow();
  });
  it("combines links to one content directory, without merging same-name independent copies", async () => {
    const canonical = await install(join(home, ".agents/skills"), "shared");
    await mkdir(join(home, ".claude/skills"), { recursive: true });
    await symlink(canonical, join(home, ".claude/skills/shared"), "dir");
    await install(join(home, ".codex/skills"), "shared");
    const inventory = await scanSkills({ home });
    expect(inventory.installations).toHaveLength(2);
    expect(
      inventory.installations.find((i) => i.realPath === canonical)?.locations,
    ).toHaveLength(2);
    expect(new Set(inventory.installations.map((i) => i.id)).size).toBe(2);
    const before = inventory.installations.map((i) => i.id).sort();
    expect(
      (await scanSkills({ home })).installations.map((i) => i.id).sort(),
    ).toEqual(before);
  });

  it("keeps malformed docs, missing docs, nested system skills and broken links visible", async () => {
    await install(join(home, ".codex/skills/.system"), "builtin");
    await install(
      join(home, ".codex/skills"),
      "invalid",
      "---\nname: [invalid\n---\n# Read me",
    );
    await mkdir(join(home, ".codex/skills/no-document"), { recursive: true });
    await symlink(
      join(fixture, "gone"),
      join(home, ".codex/skills/broken"),
      "dir",
    );
    const result = await scanSkills({ home });
    expect(result.installations).toHaveLength(4);
    expect(
      result.installations.find((i) => i.name === "builtin")?.manager,
    ).toBe("external");
    expect(
      result.installations.find((i) => i.name === "invalid")?.documentState,
    ).toBe("invalid");
    expect(
      result.installations.find((i) => i.name === "no-document")?.documentState,
    ).toBe("missing");
    expect(
      result.installations.find((i) => i.name === "broken")?.locations[0].kind,
    ).toBe("broken");
  });

  it("attaches global lock evidence only to canonical content, redacts credentials and performs no writes", async () => {
    const root = join(home, ".agents/skills");
    const canonical = await install(root, "tracked");
    const independent = await install(join(home, ".codex/skills"), "tracked");
    const lockPath = join(home, ".agents/.skill-lock.json");
    const lock = JSON.stringify({
      version: 3,
      skills: {
        tracked: {
          source: "owner/repo",
          sourceType: "github",
          sourceUrl: "https://user:secret@example.com/repo?token=hidden",
          skillFolderHash: "abcd",
          commit: "01234567",
          token: "do-not-expose",
          custom: { password: "private" },
        },
      },
    });
    await file(lockPath, lock);
    const before = await readFile(join(canonical, "SKILL.md"), "utf8");
    const result = await scanSkills({ home });
    const tracked = result.installations.find((i) => i.realPath === canonical)!;
    expect(tracked.manager).toBe("skills-cli");
    expect(tracked.provenance?.sourceUrl).toBe("https://example.com/repo");
    expect(JSON.stringify(tracked.provenance?.record)).not.toMatch(
      /secret|hidden|do-not-expose|private/,
    );
    expect(
      result.installations.find((i) => i.realPath === independent)?.provenance,
    ).toBeUndefined();
    await getSkillDetail(tracked);
    expect(await readFile(lockPath, "utf8")).toBe(lock);
    expect(await readFile(join(canonical, "SKILL.md"), "utf8")).toBe(before);
  });

  it.each([1, 2])(
    "reads project lock schema %i without borrowing a global same-name record",
    async (version) => {
      await install(join(home, ".agents/skills"), "same");
      await file(
        join(home, ".agents/.skill-lock.json"),
        JSON.stringify({
          version: 3,
          skills: { same: { source: "global/repo", skillFolderHash: "aaa" } },
        }),
      );
      await install(join(project, ".agents/skills"), "same");
      const projectLock = JSON.stringify({
        version,
        skills: {
          same: {
            source: "project/repo",
            sourceType: "github",
            computedHash: "bbb",
          },
        },
      });
      await file(join(project, "skills-lock.json"), projectLock);
      const result = await scanSkills({ home, project });
      expect(result.installations).toHaveLength(1);
      expect(result.installations[0].scope.kind).toBe("project");
      expect(result.installations[0].provenance?.source).toBe("project/repo");
      expect(result.installations[0].provenance?.hash?.algorithm).toBe(
        `skills-content-v${version}`,
      );
      expect(await readFile(join(project, "skills-lock.json"), "utf8")).toBe(
        projectLock,
      );
    },
  );

  it("retains installs when locks are corrupt, unsupported, or contain orphan records", async () => {
    await install(join(project, ".agents/skills"), "manual");
    await file(
      join(project, "skills-lock.json"),
      JSON.stringify({ version: 999, skills: {} }),
    );
    let result = await scanSkills({ home, project });
    expect(result.installations).toHaveLength(1);
    expect(result.diagnostics.map((d) => d.code)).toContain("LOCK_UNSUPPORTED");
    await writeFile(join(project, "skills-lock.json"), "<<<<<<< broken merge");
    result = await scanSkills({ home, project });
    expect(result.installations).toHaveLength(1);
    expect(result.diagnostics.map((d) => d.code)).toContain("LOCK_UNREADABLE");
    await writeFile(
      join(project, "skills-lock.json"),
      JSON.stringify({
        version: 2,
        skills: { absent: { source: "owner/repo" } },
      }),
    );
    expect(
      (await scanSkills({ home, project })).diagnostics.map((d) => d.code),
    ).toContain("LOCK_WITHOUT_INSTALLATION");
  });

  it("honors explicit Codex home, XDG state home, and custom scanning roots", async () => {
    const codexHome = join(fixture, "codex-home");
    const xdgStateHome = join(fixture, "state");
    const custom = join(fixture, "my-skills");
    await install(join(codexHome, "skills"), "custom-codex");
    await install(custom, "custom-tool");
    await file(
      join(xdgStateHome, "skills/.skill-lock.json"),
      '{"version":3,"skills":{}}',
    );
    const result = await scanSkills({
      home,
      codexHome,
      xdgStateHome,
      additionalRoots: [{ path: custom, tool: "custom" }],
    });
    expect(result.installations.map((i) => i.name).sort()).toEqual([
      "custom-codex",
      "custom-tool",
    ]);
  });

  it("bounds enumeration and document size, reporting partial results", async () => {
    await install(
      join(home, ".agents/skills"),
      "a",
      skill("a", "x".repeat(600 * 1024)),
    );
    await install(join(home, ".agents/skills"), "b");
    const result = await scanSkills({ home, maxEntries: 1 });
    expect(result.installations).toHaveLength(1);
    expect(result.truncated).toBe(true);
    const detail = await getSkillDetail(result.installations[0]);
    expect(detail.raw.length).toBeLessThanOrEqual(512 * 1024);
    expect(detail.truncated).toBe(true);
  });

  it("lists internal symlinks without traversing outside content or modifying links", async () => {
    const path = await install(join(home, ".agents/skills"), "safe");
    const outside = join(fixture, "outside");
    await file(join(outside, "secret.txt"), "not a skill resource");
    await symlink(outside, join(path, "external-resources"), "dir");
    await symlink(path, join(path, "cycle"), "dir");
    const result = await scanSkills({ home });
    const detail = await getSkillDetail(result.installations[0]);
    expect(detail.files.map((f) => f.path)).toContain("external-resources");
    expect(detail.files.some((f) => f.path.includes("secret.txt"))).toBe(false);
    expect(await readlink(join(path, "cycle"))).toBe(path);
  });

  it("does not read SKILL.md symlinks escaping the content directory", async () => {
    const path = join(home, ".agents/skills/escape");
    await mkdir(path, { recursive: true });
    await file(join(fixture, "outside.md"), "sensitive outside document");
    await symlink(join(fixture, "outside.md"), join(path, "SKILL.md"));
    const result = await scanSkills({ home });
    const detail = await getSkillDetail(result.installations[0]);
    expect(detail.raw).toBe("");
    expect(detail.diagnostics.map((d) => d.code)).toContain(
      "DOCUMENT_UNREADABLE",
    );
  });

  it("rejects stale details when the observed installation points elsewhere", async () => {
    const source = await install(join(fixture, "source"), "first");
    const second = await install(join(fixture, "source"), "second");
    const link = join(home, ".codex/skills/current");
    await mkdir(join(link, ".."), { recursive: true });
    await symlink(source, link, "dir");
    const result = await scanSkills({ home });
    await rm(link);
    await symlink(second, link, "dir");
    await expect(getSkillDetail(result.installations[0])).rejects.toMatchObject(
      { code: "STALE_INSTALLATION" },
    );
  });
});
