import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  readlink,
  readdir,
  realpath,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
  copyFile,
  symlink,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scanSkills } from "./scanner.js";
import {
  errorCode,
  plainObject,
  readBounded,
  readDocument,
} from "./document.js";
import { lockPathFor } from "./locks.js";
import { inside, scopeFor } from "./paths.js";
import {
  contentHash,
  resolveSkillsSource,
  stageSkill,
  type PreparedSource,
} from "./sources.js";
import type { Installation, ScanOptions } from "./types.js";

export type InstallTool = "codex" | "claude-code" | "cursor";
export interface OperationPreview {
  id: string;
  type: "install" | "uninstall";
  name: string;
  scopeId: string;
  scopeName: string;
  expiresAt: string;
  paths: { path: string; action: string }[];
  notes: string[];
  source?: string;
  ref?: string;
  commit?: string;
}
export interface OperationResult {
  id: string;
  type: "install" | "uninstall";
  name: string;
  scopeId: string;
  backupPath: string;
  undoAvailable: boolean;
  warning?: string;
}
export interface SourceCatalog {
  id: string;
  skills: { name: string; description: string }[];
}
interface Probe {
  path: string;
  fingerprint: string;
  parent: string;
}
interface LockSnapshot {
  path: string;
  raw?: string;
  data: Record<string, unknown> & {
    version: number;
    skills: Record<string, unknown>;
  };
}
interface Plan {
  view: OperationPreview;
  options: ScanOptions;
  probes: Probe[];
  lock: LockSnapshot;
  nextLock?: string;
  staged?: string;
  temp?: string;
  stageFingerprint?: string;
  targets: string[];
  backupPath?: string;
  moved?: { from: string; backup: string; fingerprint: string }[];
  afterLock?: string;
  state: "ready" | "running" | "done" | "failed" | "undone";
}
export class OperationError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
async function exists(path: string) {
  return !!(await lstat(path).catch((error) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }));
}
async function fingerprint(path: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  async function visit(file: string) {
    if (++count > 30000)
      throw new OperationError("目录超过 30000 项，暂不支持操作，请手动管理。");
    const info = await lstat(file, { bigint: true });
    hash.update(
      JSON.stringify([
        relative(path, file),
        String(info.dev),
        String(info.ino),
        String(info.mode),
        String(info.size),
        String(info.mtimeNs),
        String(info.ctimeNs),
      ]),
    );
    if (info.isSymbolicLink()) hash.update(await readlink(file));
    else if (info.isDirectory())
      for (const entry of (await readdir(file)).sort())
        await visit(join(file, entry));
  }
  try {
    await visit(path);
    return hash.digest("hex");
  } catch (error) {
    if (errorCode(error) === "ENOENT" && !count) return "missing";
    if (errorCode(error) === "ENOENT" && count === 1) return "missing";
    throw error;
  }
}
async function parentIdentity(path: string): Promise<string> {
  let parent = dirname(path);
  while (!(await exists(parent))) {
    const next = dirname(parent);
    if (next === parent) throw new OperationError("无法定位安装目录。");
    parent = next;
  }
  const info = await lstat(parent);
  return JSON.stringify([
    parent,
    await realpath(parent),
    info.dev,
    info.ino,
    info.isSymbolicLink() ? await readlink(parent) : "",
  ]);
}
async function probe(path: string): Promise<Probe> {
  return {
    path,
    fingerprint: await fingerprint(path),
    parent: await parentIdentity(path),
  };
}
async function checkProbe(value: Probe) {
  if (
    (await fingerprint(value.path)) !== value.fingerprint ||
    (await parentIdentity(value.path)) !== value.parent
  )
    throw new OperationError("安装内容或目录已变化，请重新预览后操作。");
}
async function assertParentWithin(path: string, base: string) {
  const identity = JSON.parse(await parentIdentity(path)) as string[];
  const canonicalBase = await realpath(base);
  if (!inside(canonicalBase, identity[1]))
    throw new OperationError(
      "安装位置的父目录链接到当前范围之外，请在原管理位置操作。",
    );
}
async function readMutableLock(options: ScanOptions): Promise<LockSnapshot> {
  const scope = scopeFor(options),
    path = lockPathFor(scope, options);
  let raw: string | undefined;
  try {
    const result = await readBounded(path, 4 * 1024 * 1024);
    if (result.truncated) throw new Error("large");
    raw = result.text;
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      throw new OperationError("锁文件无法读取，操作已停止，原文件保留。");
  }
  let parsed: unknown;
  try {
    parsed =
      raw === undefined
        ? { version: scope.kind === "global" ? 3 : 2, skills: {} }
        : JSON.parse(raw);
  } catch {
    throw new OperationError("锁文件损坏，请先修复后重试。");
  }
  if (
    !plainObject(parsed) ||
    !plainObject(parsed.skills) ||
    !(scope.kind === "global"
      ? parsed.version === 3
      : parsed.version === 1 || parsed.version === 2)
  )
    throw new OperationError("锁文件格式暂不支持写入，原文件保留。");
  return { path, raw, data: parsed as LockSnapshot["data"] };
}
async function lockUnchanged(lock: LockSnapshot) {
  const current = await readBounded(lock.path, 4 * 1024 * 1024).catch(
    (error) => {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    },
  );
  if (current?.truncated || current?.text !== lock.raw)
    throw new OperationError("锁文件已被其他进程修改，请重新预览。");
}
async function writeLock(lock: LockSnapshot, next: string) {
  await lockUnchanged(lock);
  await mkdir(dirname(lock.path), { recursive: true });
  if (lock.raw === undefined)
    await writeFile(lock.path, next, { flag: "wx", mode: 0o600 });
  else {
    const temp = `${lock.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, next, { mode: 0o600, flag: "wx" });
      await lockUnchanged(lock);
      await rename(temp, lock.path);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

export class SkillOperations {
  private sources = new Map<
    string,
    { source: PreparedSource; scopeId: string; expires: number }
  >();
  private plans = new Map<string, Plan>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly optionsFor: (scopeId: string) => ScanOptions,
    readonly allOptions: () => ScanOptions[],
  ) {}
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action);
    this.queue = task.catch(() => undefined);
    return task;
  }
  async close() {
    await this.queue;
    await Promise.all(
      [...this.sources.values()].map((s) => s.source.dispose()),
    );
    await Promise.all(
      [...this.plans.values()]
        .filter((p) => p.temp)
        .map((p) => rm(p.temp!, { recursive: true, force: true })),
    );
  }
  private async expire() {
    for (const [id, value] of this.sources)
      if (value.expires < Date.now()) {
        await value.source.dispose();
        this.sources.delete(id);
      }
    for (const [id, plan] of this.plans)
      if (
        plan.state === "ready" &&
        Date.parse(plan.view.expiresAt) < Date.now()
      ) {
        if (plan.temp) await rm(plan.temp, { recursive: true, force: true });
        this.plans.delete(id);
      }
  }
  async resolve(
    input: string,
    ref: string | undefined,
    scopeId: string,
  ): Promise<SourceCatalog> {
    await this.expire();
    if (this.sources.size >= 10)
      throw new OperationError("来源预览过多，请关闭旧窗口后重试。");
    const options = this.optionsFor(scopeId),
      scope = scopeFor(options);
    const source = await resolveSkillsSource(
      input,
      ref,
      scope.path,
      options.home ?? scope.path,
    );
    const id = randomUUID();
    this.sources.set(id, {
      source,
      scopeId,
      expires: Date.now() + 15 * 60 * 1000,
    });
    return {
      id,
      skills: source.candidates.map(({ name, description }) => ({
        name,
        description,
      })),
    };
  }
  async cancelSource(id: string) {
    const value = this.sources.get(id);
    if (value) {
      await value.source.dispose();
      this.sources.delete(id);
    }
  }
  async cancelPlan(id: string) {
    return this.serialize(async () => {
      const plan = this.plans.get(id);
      if (plan?.state === "ready") {
        this.plans.delete(id);
        if (plan.temp) await rm(plan.temp, { recursive: true, force: true });
      }
    });
  }
  async previewInstall(
    catalogId: string,
    name: string,
    tools: InstallTool[],
  ): Promise<OperationPreview> {
    await this.expire();
    if (
      [...this.plans.values()].filter((p) => p.state === "ready").length >= 20
    )
      throw new OperationError("待确认操作过多，请稍后重试。");
    const catalog = this.sources.get(catalogId);
    if (!catalog) throw new OperationError("来源预览已过期，请重新读取来源。");
    if (
      !tools.length ||
      tools.some((tool) => !["codex", "claude-code", "cursor"].includes(tool))
    )
      throw new OperationError("请至少选择一个目标工具。", 400);
    const matches = catalog.source.candidates.filter(
      (skill) => skill.name === name,
    );
    if (matches.length !== 1)
      throw new OperationError(
        "请选择来源中唯一的 Skill，同名定义需先在来源中整理。",
        400,
      );
    const candidate = matches[0],
      options = this.optionsFor(catalog.scopeId),
      scope = scopeFor(options);
    const lock = await readMutableLock(options);
    if (Object.hasOwn(lock.data.skills, name))
      throw new OperationError(
        "当前范围已有同名锁记录，请先处理已有安装或失效记录。",
      );
    const canonical = join(scope.path, ".agents/skills", name);
    const targets = [
      canonical,
      ...[...new Set(tools)].map((tool) =>
        join(
          tool === "codex" && scope.kind === "global" && options.codexHome
            ? options.codexHome
            : scope.path,
          tool === "codex" && scope.kind === "global" && options.codexHome
            ? "skills"
            : tool === "codex"
              ? ".codex/skills"
              : tool === "claude-code"
                ? ".claude/skills"
                : ".cursor/skills",
          name,
        ),
      ),
    ];
    const unique = [...new Set(targets)];
    for (const path of unique) {
      if (await exists(path))
        throw new OperationError(`安装位置已存在，保留原内容：${path}`);
      await assertParentWithin(
        path,
        scope.kind === "global" &&
          options.codexHome &&
          inside(resolve(options.codexHome), path)
          ? options.codexHome
          : scope.path,
      );
    }
    const temp = await mkdtemp(join(tmpdir(), "skills-console-install-")),
      staged = join(temp, name);
    try {
      await stageSkill(candidate.path, staged);
      const document = await readDocument(staged);
      if (document.state !== "valid" || document.metadata.name !== name)
        throw new OperationError("来源内容在准备时已变化，请重新读取。");
      const record: Record<string, unknown> = {
        ...catalog.source.info,
        skillPath: `${relative(catalog.source.root, candidate.path).split("\\").join("/") || "."}/SKILL.md`,
      };
      if (scope.kind === "global")
        Object.assign(record, {
          skillFolderHash:
            catalog.source.info.sourceType === "github"
              ? await catalog.source.treeHash(candidate)
              : await contentHash(staged, 2),
          installedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      else record.computedHash = await contentHash(staged, lock.data.version);
      lock.data.skills[name] = record;
      if (scope.kind === "global") lock.data.lastSelectedAgents = tools;
      const view: OperationPreview = {
        id: randomUUID(),
        type: "install",
        name,
        scopeId: catalog.scopeId,
        scopeName: scope.name,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        paths: unique.map((path, index) => ({
          path,
          action: index === 0 ? "安装内容" : "创建工具链接",
        })),
        notes: [
          "共享目录会对读取它的其他工具可见。",
          "同名位置不会覆盖；内容按预览快照安装。",
        ],
        source: catalog.source.info.source,
        ref: catalog.source.info.ref,
        commit: catalog.source.info.commit,
      };
      view.paths.push({ path: lock.path, action: "写入安装来源记录" });
      this.plans.set(view.id, {
        view,
        options,
        targets: unique,
        probes: await Promise.all(unique.map(probe)),
        lock,
        nextLock: json(lock.data),
        staged,
        temp,
        stageFingerprint: await fingerprint(staged),
        state: "ready",
      });
      return view;
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
  }
  async current(scopeId: string, id: string): Promise<Installation> {
    const data = await scanSkills(this.optionsFor(scopeId));
    const item = data.installations.find((item) => item.id === id);
    if (!item) throw new OperationError("安装已变化，请刷新列表。", 404);
    return item;
  }
  async previewUninstall(
    scopeId: string,
    id: string,
    indexes?: number[],
  ): Promise<OperationPreview> {
    await this.expire();
    if (
      [...this.plans.values()].filter((p) => p.state === "ready").length >= 20
    )
      throw new OperationError("待确认操作过多，请稍后重试。");
    const options = this.optionsFor(scopeId),
      item = await this.current(scopeId, id);
    const selected = indexes ?? item.locations.map((_, index) => index);
    if (
      !selected.length ||
      selected.some((i) => !Number.isInteger(i) || !item.locations[i]) ||
      new Set(selected).size !== selected.length
    )
      throw new OperationError("请选择有效的安装位置。", 400);
    const locations = selected.map((index) => item.locations[index]);
    const directories = [];
    for (const location of locations) {
      const info = await lstat(location.path);
      if (
        !inside(location.rootPath, location.path) ||
        location.path === location.rootPath ||
        /[\\/]\.system(?:[\\/]|$)/.test(location.path)
      )
        throw new OperationError("内置或管理根目录不能在此卸载。");
      if (!info.isSymbolicLink()) {
        if (item.manager === "external")
          throw new OperationError(
            "此 Skill 由外部工具管理，请使用原工具卸载；可在这里打开目录。",
          );
        if ((await realpath(location.rootPath)) !== resolve(location.rootPath))
          throw new OperationError(
            "安装根目录是链接，请在原目录管理内容；单个链接入口可直接移除。",
          );
        const base = options.additionalRoots?.some(
          (root) => root.path === location.rootPath,
        )
          ? location.rootPath
          : options.codexHome &&
              inside(resolve(options.codexHome), location.path)
            ? options.codexHome
            : scopeFor(options).path;
        await assertParentWithin(location.path, base);
        directories.push(location.path);
      }
    }
    if (directories.length && item.realPath) {
      for (const otherOptions of this.allOptions()) {
        const data = await scanSkills(otherOptions);
        if (data.truncated)
          throw new OperationError(
            "扫描结果不完整，无法确认共享内容的关联，请先处理扫描提示。",
          );
        const remaining = data.installations
          .filter((i) => i.realPath === item.realPath)
          .flatMap((i) => i.locations)
          .filter(
            (l) => !locations.some((selected) => selected.path === l.path),
          );
        if (remaining.length)
          throw new OperationError(
            `内容仍被其他位置引用，请先移除关联：${remaining[0].path}`,
          );
      }
    }
    const lock = await readMutableLock(options);
    let nextLock: string | undefined;
    if (
      item.provenance &&
      locations.some(
        (l) =>
          l.path ===
          join(
            scopeFor(options).path,
            ".agents/skills",
            item.provenance!.recordKey,
          ),
      )
    ) {
      delete lock.data.skills[item.provenance.recordKey];
      nextLock = json(lock.data);
    }
    const view: OperationPreview = {
      id: randomUUID(),
      type: "uninstall",
      name: item.name,
      scopeId,
      scopeName: item.scope.name,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      paths: locations.map((l) => ({
        path: l.path,
        action:
          l.kind === "directory" ? "移出安装目录并备份" : "移除链接并备份",
      })),
      notes: [
        "软链接指向的源项目会保留。",
        "卸载前保留备份，可在本次会话中撤销。",
      ],
    };
    if (nextLock)
      view.paths.push({ path: lock.path, action: "移除对应安装记录" });
    this.plans.set(view.id, {
      view,
      options,
      lock,
      nextLock,
      targets: locations.map((l) => l.path),
      probes: await Promise.all(locations.map((l) => probe(l.path))),
      state: "ready",
    });
    return view;
  }
  async apply(id: string): Promise<OperationResult> {
    return this.serialize(async () => {
      const plan = this.plans.get(id);
      if (
        !plan ||
        plan.state !== "ready" ||
        Date.parse(plan.view.expiresAt) < Date.now()
      )
        throw new OperationError("操作预览已失效或已执行，请重新预览。");
      for (const p of plan.probes) await checkProbe(p);
      await lockUnchanged(plan.lock);
      if (
        plan.staged &&
        (await fingerprint(plan.staged)) !== plan.stageFingerprint
      )
        throw new OperationError("准备的内容已变化，请重新读取来源。");
      plan.state = "running";
      const directory = join(this.directory, plan.view.id);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      plan.backupPath = directory;
      plan.moved = [];
      await writeFile(
        join(directory, "operation.json"),
        json({
          ...plan.view,
          state: "running",
          lockPath: plan.lock.path,
          lockBefore: plan.lock.raw,
          paths: plan.targets,
        }),
        { mode: 0o600 },
      );
      const created: { path: string; fingerprint: string }[] = [];
      try {
        if (plan.view.type === "install") {
          const canonical = plan.targets[0];
          await mkdir(dirname(canonical), { recursive: true });
          await mkdir(canonical);
          created.push({
            path: canonical,
            fingerprint: await fingerprint(canonical),
          });
          // The exclusive destination avoids replacing a directory created after preview.
          async function copy(from: string, to: string) {
            for (const entry of await readdir(from, { withFileTypes: true })) {
              if (entry.isDirectory()) {
                await mkdir(join(to, entry.name));
                await copy(join(from, entry.name), join(to, entry.name));
              } else
                await copyFile(
                  join(from, entry.name),
                  join(to, entry.name),
                  constants.COPYFILE_EXCL,
                );
            }
          }
          await copy(plan.staged!, canonical);
          created[0].fingerprint = await fingerprint(canonical);
          for (const path of plan.targets.slice(1)) {
            await mkdir(dirname(path), { recursive: true });
            await symlink(
              canonical,
              path,
              process.platform === "win32" ? "junction" : "dir",
            );
            created.push({ path, fingerprint: await fingerprint(path) });
          }
        } else {
          for (let index = 0; index < plan.targets.length; index++) {
            const from = plan.targets[index],
              backup = join(directory, `location-${index}`);
            await rename(from, backup);
            plan.moved.push({
              from,
              backup,
              fingerprint: await fingerprint(backup),
            });
          }
        }
        if (plan.nextLock !== undefined)
          await writeLock(plan.lock, plan.nextLock);
        plan.afterLock = plan.nextLock ?? plan.lock.raw;
        plan.state = "done";
        let warning: string | undefined;
        try {
          await writeFile(
            join(directory, "operation.json"),
            json({
              ...plan.view,
              state: "done",
              lockPath: plan.lock.path,
              lockBefore: plan.lock.raw,
              lockAfter: plan.afterLock,
              locations: plan.moved ?? [],
              created,
            }),
            { mode: 0o600 },
          );
        } catch {
          warning = "操作已完成，但结果记录保存失败，请保留备份目录。";
        }
        if (plan.temp) {
          try {
            await rm(plan.temp, { recursive: true, force: true });
            plan.temp = undefined;
          } catch {
            /* Retry cleanup on server close. */
          }
        }
        return {
          id,
          type: plan.view.type,
          name: plan.view.name,
          scopeId: plan.view.scopeId,
          backupPath: directory,
          undoAvailable: plan.view.type === "uninstall",
          warning,
        };
      } catch (error) {
        let recovered = true;
        for (const entry of created.reverse()) {
          if ((await fingerprint(entry.path)) === entry.fingerprint)
            await rm(entry.path, { recursive: true, force: true }).catch(() => {
              recovered = false;
            });
          else recovered = false;
        }
        for (const entry of [...plan.moved].reverse()) {
          if (!(await exists(entry.from)))
            await rename(entry.backup, entry.from).catch(() => {
              recovered = false;
            });
          else recovered = false;
        }
        plan.state = "failed";
        throw new OperationError(
          `${errorCode(error) === "EXDEV" ? "备份目录与安装位置不在同一磁盘，无法安全移动。" : error instanceof Error ? error.message : "操作失败。"}${recovered ? " 已保留原内容。" : ` 请检查恢复记录：${directory}`}`,
        );
      }
    });
  }
  async undo(id: string): Promise<void> {
    return this.serialize(async () => {
      const plan = this.plans.get(id);
      if (!plan || plan.state !== "done" || plan.view.type !== "uninstall")
        throw new OperationError("该操作不可撤销，或不属于本次会话。");
      const lock = await readMutableLock(plan.options);
      if (lock.raw !== plan.afterLock)
        throw new OperationError(
          "锁文件已有后续变化，请按备份手动恢复，避免覆盖新记录。",
        );
      for (const moved of plan.moved ?? []) {
        if (
          (await exists(moved.from)) ||
          (await fingerprint(moved.backup)) !== moved.fingerprint
        )
          throw new OperationError("原位置已被占用或备份已变化，恢复已停止。");
        const original = plan.probes.find((p) => p.path === moved.from)!;
        if ((await parentIdentity(moved.from)) !== original.parent)
          throw new OperationError("原安装目录已变化，恢复已停止。");
      }
      const restored: { from: string; backup: string }[] = [];
      try {
        for (const moved of plan.moved ?? []) {
          await rename(moved.backup, moved.from);
          restored.push(moved);
        }
        if (plan.nextLock !== undefined && plan.lock.raw !== undefined)
          await writeLock(lock, plan.lock.raw);
        plan.state = "undone";
        await writeFile(
          join(plan.backupPath!, "operation.json"),
          json({
            ...plan.view,
            state: "undone",
            lockPath: plan.lock.path,
            lockBefore: plan.lock.raw,
            lockAfter: plan.afterLock,
            locations: plan.moved,
            restoredAt: new Date().toISOString(),
          }),
          { mode: 0o600 },
        ).catch(() => undefined);
      } catch (error) {
        for (const moved of restored.reverse())
          if (!(await exists(moved.backup)))
            await rename(moved.from, moved.backup);
        throw error;
      }
    });
  }
}
