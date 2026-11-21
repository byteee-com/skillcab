import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { tmpdir, homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import {
  plainObject,
  readBounded,
  errorCode,
  readDocument,
} from "./document.js";
import {
  contentHash,
  resolveSkillsSource,
  stageSkill,
  type PreparedSource,
  type SourceCandidate,
} from "./sources.js";
import type {
  Installation,
  Inventory,
  SourceTracking,
  UpdateCheck,
} from "./types.js";

interface SavedCheck {
  signature: string;
  localHash?: string;
  result: UpdateCheck;
}
interface VersionData {
  version: 1;
  sources: Record<
    string,
    { realPath: string; identity: string; tracking: SourceTracking }
  >;
  checks: Record<string, SavedCheck>;
}
const blank = (): VersionData => ({ version: 1, sources: {}, checks: {} });
const hash = (input: unknown) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
export function sourcePath(path: string) {
  const value = path
    .replaceAll("\\", "/")
    .replace(/\/?SKILL\.md$/, "")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (
    value.startsWith("/") ||
    value.split("/").some((s) => s === "..") ||
    /^[A-Za-z]:/.test(value)
  )
    throw new Error("来源子目录必须是仓库内的相对路径。");
  return value === "." ? "" : value;
}
function selectCandidate(
  source: PreparedSource,
  item: Installation,
  path?: string,
  originalName?: string,
): SourceCandidate {
  const candidates =
    path !== undefined
      ? source.candidates.filter(
          (c) => sourcePath(relative(source.root, c.path)) === sourcePath(path),
        )
      : source.candidates.filter(
          (c) =>
            c.name === (originalName ?? item.name) ||
            c.name === item.directoryName,
        );
  if (candidates.length !== 1)
    throw new Error(
      "无法唯一定位来源中的 Skill，请填写准确的仓库内目录（根目录填 .）。",
    );
  return candidates[0];
}
async function directoryIdentity(path: string) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("安装内容目录已变化，请重新扫描。");
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}
function trackingFor(item: Installation) {
  if (item.provenance) return item.provenance;
  return item.tracking;
}
function sourceInput(item: Installation) {
  const p = trackingFor(item);
  if (!p) return;
  if (
    p.sourceType &&
    !["github", "gitlab", "git", "local"].includes(p.sourceType)
  )
    return;
  // Normalized GitHub IDs avoid feeding an embedded /tree ref back into ref-aware resolution.
  if (p.sourceType === "github" && /^[\w.-]+\/[\w.-]+$/.test(p.source))
    return p.source;
  return p.sourceUrl ?? p.source;
}
function signature(item: Installation) {
  return hash({
    realPath: item.realPath,
    name: item.name,
    directoryName: item.directoryName,
    provenance: item.provenance,
    tracking: item.tracking,
  });
}
// Copy first to enforce file/byte limits and reject links instead of silently omitting content.
async function snapshotHash(
  path: string,
  schema = 2,
  installedName?: string,
): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), "skills-console-check-"));
  const copy = join(temp, "content");
  try {
    await stageSkill(path, copy, schema);
    if (installedName) {
      const docPath = join(copy, "SKILL.md");
      const text = await readFile(docPath, "utf8");
      const match = text.match(
        /^(\uFEFF?---(\r?\n))([\s\S]*?)(\r?\n---(?:\r?\n|$))/,
      );
      if (match && parseDocument(match[3]).get("name") !== installedName) {
        // Match npx skills' name-only rewrite; preserve unrelated YAML formatting.
        const rows = match[3].split(/\r?\n/);
        const start = rows.findIndex((line) => /^name\s*:/.test(line));
        let end = start + 1;
        while (start >= 0 && end < rows.length && /^[ \t]/.test(rows[end]))
          end++;
        const replacement = stringify({ name: installedName }).trimEnd();
        if (start < 0) rows.unshift(replacement);
        else rows.splice(start, end - start, replacement);
        await writeFile(
          docPath,
          match[1] +
            rows.join(match[2]) +
            match[4] +
            text.slice(match[0].length),
        );
      }
    }
    return await contentHash(copy, schema);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export class VersionService {
  private queue: Promise<unknown> = Promise.resolve();
  private checking?: Promise<Inventory>;
  constructor(
    readonly path: string,
    readonly home = homedir(),
    private readonly resolveSource = resolveSkillsSource,
  ) {}
  private async load(): Promise<{ data: VersionData; raw?: string }> {
    try {
      const file = await readBounded(this.path, 4 * 1024 * 1024);
      const data: unknown = JSON.parse(file.text);
      if (
        file.truncated ||
        !plainObject(data) ||
        data.version !== 1 ||
        !plainObject(data.sources) ||
        !plainObject(data.checks)
      )
        throw new Error();
      for (const value of Object.values(data.sources)) {
        if (
          !plainObject(value) ||
          typeof value.realPath !== "string" ||
          typeof value.identity !== "string" ||
          !plainObject(value.tracking) ||
          typeof value.tracking.source !== "string" ||
          typeof value.tracking.sourceUrl !== "string" ||
          typeof value.tracking.skillPath !== "string"
        )
          throw new Error();
      }
      for (const value of Object.values(data.checks)) {
        if (
          !plainObject(value) ||
          typeof value.signature !== "string" ||
          !plainObject(value.result) ||
          ![
            "available",
            "current",
            "unknown",
            "error",
            "untracked",
            "unchecked",
            "unsupported",
          ].includes(String(value.result.status))
        )
          throw new Error();
      }
      return { data: data as unknown as VersionData, raw: file.text };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { data: blank() };
      throw new Error(
        "版本记录无法读取或格式损坏，请检查 versions.json；原文件已保留。",
      );
    }
  }
  private mutate(action: (data: VersionData) => void) {
    const job = this.queue.then(async () => {
      const { data, raw } = await this.load();
      action(data);
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      if (
        await lstat(this.path).then(
          (s) => s.isSymbolicLink(),
          () => false,
        )
      )
        throw new Error("版本记录不能是软链接。");
      const current = await readFile(this.path, "utf8").catch((error) => {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      });
      if (raw !== current)
        throw new Error("版本记录已被其他进程修改，请重试。");
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        const encoded = JSON.stringify(data, null, 2) + "\n";
        if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
          throw new Error("版本记录已达容量上限，请清理旧项目的检查记录。");
        await writeFile(temp, encoded, {
          mode: 0o600,
          flag: "wx",
        });
        await rename(temp, this.path);
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
  async decorate(inventory: Inventory): Promise<Inventory> {
    let data: VersionData;
    try {
      ({ data } = await this.load());
    } catch (error) {
      inventory.diagnostics.push({
        code: "VERSIONS_UNREADABLE",
        message: (error as Error).message,
      });
      return inventory;
    }
    for (const item of inventory.installations) {
      delete item.tracking;
      const saved = data.sources[item.id];
      if (
        !item.provenance &&
        saved &&
        saved.realPath === item.realPath &&
        saved.identity ===
          (await directoryIdentity(saved.realPath).catch(() => undefined))
      )
        item.tracking = saved.tracking;
      item.update = {
        status: trackingFor(item) ? "unchecked" : "untracked",
        message: trackingFor(item)
          ? "尚未检查来源。"
          : "关联来源后可检查更新。",
      };
      const cached = data.checks[item.id];
      if (cached?.signature === signature(item)) {
        const checked = Date.parse(cached.result.checkedAt ?? "");
        if (
          !Number.isFinite(checked) ||
          Date.now() - checked > 24 * 60 * 60 * 1000
        ) {
          item.update = {
            status: "unchecked",
            message: "上次检查已过期，请重新检查。",
            checkedAt: cached.result.checkedAt,
          };
          continue;
        }
        if (cached.localHash === undefined) {
          item.update = cached.result;
          continue;
        }
        // A cached 'latest' result must never survive a local edit unnoticed.
        const local = item.realPath
          ? await snapshotHash(item.realPath).catch(() => undefined)
          : undefined;
        item.update =
          local === cached.localHash
            ? cached.result
            : { status: "unchecked", message: "本地内容已变化，请重新检查。" };
      }
    }
    return inventory;
  }
  async register(
    item: Installation,
    input: string,
    ref?: string,
    skillPath?: string,
  ) {
    if (item.provenance)
      throw new Error(
        "此安装已有 CLI 来源记录；请在对应锁文件中管理，避免覆盖来源证据。",
      );
    if (!item.realPath || item.documentState !== "valid")
      throw new Error("请先修复有效的 Skill 安装后再关联来源。");
    const identity = await directoryIdentity(item.realPath);
    const source = await this.resolveSource(
      input,
      ref,
      item.scope.path,
      this.home,
    );
    try {
      const candidate = selectCandidate(source, item, skillPath);
      const before = await snapshotHash(item.realPath);
      const upstream = await snapshotHash(candidate.path, 2, item.name);
      const tracking: SourceTracking = {
        ...source.info,
        skillPath:
          relative(source.root, candidate.path).split("\\").join("/") || ".",
        originalName: candidate.name,
        registeredAt: new Date().toISOString(),
        baseline:
          before === upstream
            ? { hash: before, commit: source.info.commit }
            : undefined,
      };
      if (
        identity !== (await directoryIdentity(item.realPath)) ||
        before !== (await snapshotHash(item.realPath))
      )
        throw new Error("本地内容在关联时发生变化，请重试。");
      await this.mutate((data) => {
        data.sources[item.id] = {
          realPath: item.realPath!,
          identity,
          tracking,
        };
        delete data.checks[item.id];
      });
      return tracking;
    } finally {
      await source.dispose();
    }
  }
  async remove(item: Installation) {
    await this.mutate((data) => {
      delete data.sources[item.id];
      delete data.checks[item.id];
    });
  }
  check(inventory: Inventory): Promise<Inventory> {
    if (this.checking) throw new Error("已有更新检查正在进行，请稍候重试。");
    const job = this.run(inventory).finally(() => {
      this.checking = undefined;
    });
    this.checking = job;
    return job;
  }
  private async run(inventory: Inventory) {
    await this.decorate(inventory);
    const sources = new Map<string, Promise<PreparedSource>>();
    const records: Record<string, SavedCheck> = {};
    const items = [...inventory.installations];
    const checkOne = async (item: Installation) => {
      const checkedAt = new Date().toISOString();
      const p = trackingFor(item);
      let result: UpdateCheck;
      let localHash: string | undefined;
      try {
        if (!p)
          result = {
            status: "untracked",
            message: "未关联来源，无法判断是否有更新。",
          };
        else if (!sourceInput(item))
          result = {
            status: "unsupported",
            message: "此来源由外部工具管理，当前支持 Git 和本地目录检查。",
          };
        else if (!item.realPath || item.documentState !== "valid")
          result = { status: "unknown", message: "本地安装无法完整读取。" };
        else {
          localHash = await snapshotHash(item.realPath);
          const key = JSON.stringify([
            sourceInput(item),
            p.ref,
            item.scope.path,
          ]);
          let fetched = sources.get(key);
          if (!fetched) {
            fetched = this.resolveSource(
              sourceInput(item)!,
              p.ref,
              item.scope.path,
              this.home,
            );
            sources.set(key, fetched);
          }
          const source = await fetched;
          const candidate = selectCandidate(
            source,
            item,
            p.skillPath,
            p.originalName,
          );
          const upstream = await snapshotHash(candidate.path, 2, item.name);
          const doc = await readDocument(candidate.path);
          const metadata = plainObject(doc.metadata.metadata)
            ? doc.metadata.metadata
            : {};
          result = {
            status: "unknown",
            message: "历史版本未知；本地内容与当前来源不同。",
            checkedAt,
            upstreamCommit: source.info.commit,
            upstreamRef: source.info.ref,
            upstreamVersion:
              typeof (metadata.version ?? doc.metadata.version) === "string"
                ? String(metadata.version ?? doc.metadata.version)
                : undefined,
            localState: "unknown",
          };
          let baseHash: string | undefined;
          let upstreamHash = upstream;
          let currentHash = localHash;
          if (
            item.provenance?.hash?.algorithm === "git-tree" &&
            /^[a-f0-9]{40,64}$/i.test(item.provenance.hash.value)
          ) {
            baseHash = item.provenance.hash.value;
            upstreamHash = await source.treeHash(candidate);
            // When upstream still equals Base, it can verify the current files too.
            if (baseHash === upstreamHash)
              result.localState = localHash === upstream ? "clean" : "modified";
          } else if (
            item.provenance?.hash?.algorithm.startsWith("skills-content-v")
          ) {
            const schema = item.provenance.schema;
            baseHash = /^[a-f0-9]{64}$/i.test(item.provenance.hash.value)
              ? item.provenance.hash.value
              : undefined;
            currentHash =
              schema === 1 ? await snapshotHash(item.realPath, 1) : localHash;
            upstreamHash =
              schema === 1
                ? await snapshotHash(candidate.path, 1, item.name)
                : upstream;
            if (baseHash)
              result.localState =
                currentHash === baseHash ? "clean" : "modified";
          } else if (item.tracking?.baseline) {
            baseHash = item.tracking.baseline.hash;
            result.localState = localHash === baseHash ? "clean" : "modified";
          }
          if (baseHash) {
            result.status = baseHash === upstreamHash ? "current" : "available";
            result.message =
              result.status === "available"
                ? "跟踪来源中的此 Skill 已变化。"
                : "跟踪来源中的此 Skill 与记录版本一致。";
          } else if (localHash === upstream) {
            result.status = "current";
            result.localState = "clean";
            result.message =
              "当前本地内容与跟踪来源一致，历史安装版本仍未记录。";
          }
          if (localHash !== (await snapshotHash(item.realPath)))
            throw new Error("本地内容在检查时变化，请重新检查。");
        }
      } catch (error) {
        result = {
          status: "error",
          message:
            error instanceof Error ? error.message : "来源检查失败，请重试。",
        };
      }
      result.checkedAt ??= checkedAt;
      item.update = result;
      records[item.id] = { signature: signature(item), localHash, result };
    };
    try {
      // Bounded concurrency; duplicate repositories share the same fetched snapshot.
      await Promise.all(
        Array.from({ length: Math.min(3, items.length) }, async () => {
          while (items.length) await checkOne(items.shift()!);
        }),
      );
      await this.mutate((data) => {
        for (const item of inventory.installations) {
          const current = data.sources[item.id];
          if (
            !item.provenance &&
            JSON.stringify(current?.tracking) !== JSON.stringify(item.tracking)
          )
            continue;
          data.checks[item.id] = records[item.id];
        }
      });
      return inventory;
    } finally {
      await Promise.all(
        [...sources.values()].map(async (source) => {
          await (await source.catch(() => undefined))?.dispose();
        }),
      );
    }
  }
}
