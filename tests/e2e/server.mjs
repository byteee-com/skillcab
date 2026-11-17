import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../../dist/server.js";

const fixture = await realpath(
  await mkdtemp(join(tmpdir(), "skills-console-browser-")),
);
const home = join(fixture, "home");
const project = join(fixture, "sample-project");
const secondProject = join(fixture, "another-project");
async function skill(root, name, description, body) {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: "1.0.0"\n---\n${body}\n`,
  );
}
await skill(
  join(home, ".agents/skills"),
  "repository-map",
  "Read and understand a repository",
  "# Repository map\n\nA **read-only** guide.\n\n<script>window.__skillExecuted = true</script>\n\n![External](https://example.invalid/tracker.png)",
);
await writeFile(
  join(home, ".agents/.skill-lock.json"),
  JSON.stringify({
    version: 3,
    skills: {
      "repository-map": {
        source: "example/skills",
        sourceType: "github",
        ref: "main",
        skillFolderHash: "aabbcc",
      },
    },
  }),
);
await skill(
  join(home, ".codex/skills"),
  "local-notes",
  "A manually installed Skill",
  "# Local notes\n\nNo source has been inferred.",
);
await symlink(
  join(fixture, "missing-source"),
  join(home, ".codex/skills/broken-link"),
  "dir",
);
await skill(
  join(project, ".agents/skills"),
  "project-reader",
  "A project scoped reader",
  "# Project reader\n\nVisible only in this project installation.",
);
await skill(
  join(secondProject, ".claude/skills"),
  "second-reader",
  "Another project Skill",
  "# Second reader\n",
);
await mkdir(".local", { recursive: true });
await writeFile(
  ".local/e2e-state.json",
  JSON.stringify({ home, project, secondProject }),
);
const { app } = await createServer({
  home,
  projects: [project],
  token: "browser-test-session",
  configPath: join(fixture, "config.json"),
});
await app.listen({ host: "127.0.0.1", port: 4318 });
async function close() {
  await app.close();
  await rm(fixture, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
