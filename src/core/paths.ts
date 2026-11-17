import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ScanOptions, ScanRoot, Scope } from "./types.js";

export const toolNames = {
  shared: "共享目录",
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  custom: "自定义",
};
export const stableId = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
export function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}
export function scopeFor(options: ScanOptions): Scope {
  const path = resolve(options.project ?? options.home ?? homedir());
  return {
    id: options.project ? `project:${stableId(path)}` : "global",
    kind: options.project ? "project" : "global",
    name: options.project
      ? path.split(/[\\/]/).filter(Boolean).at(-1)!
      : "全局 Skills",
    path,
  };
}
export function rootsFor(scope: Scope, options: ScanOptions): ScanRoot[] {
  const roots: ScanRoot[] = [
    { path: join(scope.path, ".agents/skills"), tool: "shared" },
    { path: join(scope.path, ".codex/skills"), tool: "codex" },
    { path: join(scope.path, ".claude/skills"), tool: "claude-code" },
    { path: join(scope.path, ".cursor/skills"), tool: "cursor" },
  ];
  if (scope.kind === "global" && options.codexHome)
    roots.push({
      path: join(resolve(options.codexHome), "skills"),
      tool: "codex",
    });
  roots.push(
    ...(options.additionalRoots ?? []).map((root) => ({
      ...root,
      path: resolve(root.path),
    })),
  );
  return [...new Map(roots.map((root) => [root.path, root])).values()];
}
