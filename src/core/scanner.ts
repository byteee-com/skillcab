import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { readDocument, errorCode, plainObject, textField } from "./document.js";
import { readLock } from "./locks.js";
import { inside, rootsFor, scopeFor, stableId } from "./paths.js";
import type {
  Diagnostic,
  Installation,
  Inventory,
  Location,
  ResourceFile,
  ScanOptions,
  ScanRoot,
  SkillDetail,
} from "./types.js";

const SKIP = new Set([
  ".git",
  "node_modules",
  ".DS_Store",
  "__pycache__",
  ".cache",
]);
const MAX_VISITS = 6000;

export async function scanSkills(
  options: ScanOptions = {},
): Promise<Inventory> {
  const scope = scopeFor(options);
  const lock = await readLock(scope, options);
  const inventory: Inventory = {
    scope,
    roots: [],
    installations: [],
    diagnostics: [...lock.diagnostics],
    scannedAt: new Date().toISOString(),
    truncated: false,
  };
  if (scope.kind === "project") {
    try {
      if (!(await stat(scope.path)).isDirectory())
        throw new Error("Not a directory");
    } catch {
      inventory.diagnostics.push({
        code: "PROJECT_UNREADABLE",
        message: "项目目录不存在或无法读取；不是已确认的空项目。",
        path: scope.path,
      });
    }
  }
  const grouped = new Map<string, Installation>();
  let visits = 0;
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 2500, 5000));

  async function add(
    path: string,
    root: ScanRoot,
    force = false,
  ): Promise<boolean> {
    if (++visits > MAX_VISITS || grouped.size >= maxEntries) {
      inventory.truncated = true;
      return false;
    }
    let location: Location = {
      path,
      rootPath: root.path,
      tool: root.tool,
      kind: "directory",
    };
    let canonical: string | undefined;
    const diagnostics: Diagnostic[] = [];
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink())
        location = {
          ...location,
          kind: "symlink",
          linkTarget: await readlink(path),
        };
      else if (!info.isDirectory()) return false;
      canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory()) return false;
    } catch (error) {
      location.kind = "broken";
      diagnostics.push({
        code: "LOCATION_UNREADABLE",
        message: `安装位置无法读取或链接失效（${errorCode(error)}）。`,
        path,
      });
    }
    const doc = canonical ? await readDocument(canonical) : undefined;
    if (doc?.state === "missing" && !force) return false;
    const key = canonical ?? path;
    const existing = grouped.get(key);
    if (existing) {
      if (!existing.locations.some((l) => l.path === path))
        existing.locations.push(location);
      return true;
    }
    const metadata = doc?.metadata ?? {};
    const extra = plainObject(metadata.metadata) ? metadata.metadata : {};
    const external =
      /(?:^|[\\/])(?:\.system|plugins[\\/]cache|\.umeng-cli)(?:[\\/]|$)/.test(
        path,
      ) ||
      (!!canonical &&
        /(?:[\\/])(?:plugins[\\/]cache|\.umeng-cli)(?:[\\/]|$)/.test(
          canonical,
        ));
    grouped.set(key, {
      id: stableId(`${scope.id}\0${key}`),
      scope,
      name: textField(metadata.name, 200) ?? basename(path),
      directoryName: basename(path),
      description: textField(metadata.description, 4000) ?? "",
      declaredVersion: textField(extra.version ?? metadata.version, 120),
      author: textField(extra.author ?? metadata.author, 200),
      realPath: canonical,
      locations: [location],
      manager: external ? "external" : "local",
      documentState: doc?.state ?? "unreadable",
      diagnostics: [...diagnostics, ...(doc?.diagnostics ?? [])],
    });
    return true;
  }
  async function discover(
    path: string,
    root: ScanRoot,
    depth: number,
    ancestors: Set<string>,
  ): Promise<boolean> {
    if (inventory.truncated) return false;
    if (await add(path, root)) return true;
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch {
      return false;
    }
    if (ancestors.has(canonical)) return false;
    const next = new Set(ancestors).add(canonical);
    let found = false;
    if (depth < 3) {
      try {
        for (const child of (await readdir(path, { withFileTypes: true })).sort(
          (a, b) => a.name.localeCompare(b.name),
        )) {
          if (SKIP.has(child.name) || !child.isDirectory()) continue;
          found =
            (await discover(join(path, child.name), root, depth + 1, next)) ||
            found;
          if (inventory.truncated) break;
        }
      } catch (error) {
        inventory.diagnostics.push({
          code: "DIRECTORY_UNREADABLE",
          message: `目录读取失败（${errorCode(error)}）。`,
          path,
        });
      }
    }
    if (!found && depth === 0) return add(path, root, true);
    return found;
  }

  for (const root of rootsFor(scope, options)) {
    try {
      const children = await readdir(root.path, { withFileTypes: true });
      inventory.roots.push({ ...root, state: "present" });
      for (const child of children.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (
          SKIP.has(child.name) ||
          !(child.isDirectory() || child.isSymbolicLink())
        )
          continue;
        await discover(join(root.path, child.name), root, 0, new Set());
        if (inventory.truncated) break;
      }
    } catch (error) {
      const missing = errorCode(error) === "ENOENT";
      inventory.roots.push({ ...root, state: missing ? "missing" : "error" });
      if (!missing)
        inventory.diagnostics.push({
          code: "ROOT_UNREADABLE",
          message: `扫描位置读取失败（${errorCode(error)}）。`,
          path: root.path,
        });
    }
  }

  const canonicalRoots = new Map<string, string>();
  for (const root of inventory.roots.filter(
    (r) => r.tool === "shared" && r.state === "present",
  )) {
    const path = await realpath(root.path).catch(() => root.path);
    canonicalRoots.set(root.path, path);
  }
  for (const installation of grouped.values()) {
    const candidates = installation.locations.map((l) => basename(l.path));
    const entry = candidates
      .map((name) => lock.entries.get(name))
      .find(Boolean);
    if (entry) {
      const trusted =
        installation.realPath &&
        [...canonicalRoots.values()].some(
          (root) =>
            relative(root, installation.realPath!) ===
            installation.directoryName,
        );
      if (trusted) {
        installation.provenance = entry;
        installation.manager =
          entry.sourceType === "node_modules" ? "external" : "skills-cli";
      } else
        installation.diagnostics.push({
          code: "SOURCE_UNVERIFIED",
          message: "锁文件有同名记录，但尚不能确认它对应这份独立内容。",
        });
    }
    inventory.installations.push(installation);
  }
  for (const [key] of lock.entries) {
    if (!inventory.installations.some((i) => i.provenance?.recordKey === key))
      inventory.diagnostics.push({
        code: "LOCK_WITHOUT_INSTALLATION",
        message: `记录「${key}」未匹配到共享目录中的安装。`,
        path: lock.path,
      });
  }
  inventory.installations.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
  if (inventory.truncated)
    inventory.diagnostics.push({
      code: "SCAN_LIMIT",
      message: "已达到扫描数量上限，当前列表不完整。",
    });
  return inventory;
}

export async function getSkillDetail(
  installation: Installation,
): Promise<SkillDetail> {
  const diagnostics: Diagnostic[] = [];
  const files: ResourceFile[] = [];
  let truncated = false;
  let visitedDirectories = 0;
  const root = installation.realPath;
  if (!root)
    return {
      installation,
      raw: "",
      markdown: "",
      metadata: {},
      files,
      truncated,
      diagnostics: installation.diagnostics,
    };
  // Revalidate each observed entry before following it: a link may have changed since scanning.
  const current = await Promise.all(
    installation.locations.map((l) => realpath(l.path).catch(() => undefined)),
  );
  if (!current.includes(root))
    throw Object.assign(new Error("安装位置已变化，请刷新列表。"), {
      code: "STALE_INSTALLATION",
    });
  const doc = await readDocument(root);
  async function walk(dir: string, depth: number) {
    if (files.length >= 300 || depth > 5 || ++visitedDirectories > 2000) {
      truncated = true;
      return;
    }
    try {
      if (!inside(root!, await realpath(dir))) return;
      for (const child of (await readdir(dir, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (SKIP.has(child.name)) continue;
        if (files.length >= 300) {
          truncated = true;
          break;
        }
        const path = join(dir, child.name);
        if (child.isSymbolicLink())
          files.push({ path: relative(root!, path), kind: "symlink" });
        else if (child.isDirectory()) await walk(path, depth + 1);
        else if (child.isFile()) {
          const info = await lstat(path).catch(() => undefined);
          files.push({
            path: relative(root!, path),
            kind: "file",
            size: info?.size,
          });
        }
      }
    } catch (error) {
      diagnostics.push({
        code: "FILES_UNREADABLE",
        message: `资源清单读取不完整（${errorCode(error)}）。`,
        path: dir,
      });
    }
  }
  await walk(root, 0);
  return {
    installation,
    raw: doc.raw,
    markdown: doc.markdown,
    metadata: doc.metadata,
    files,
    truncated: truncated || doc.truncated,
    diagnostics: [...doc.diagnostics, ...diagnostics],
  };
}
