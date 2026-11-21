import { join } from "node:path";
import { errorCode, plainObject, readBounded, textField } from "./document.js";
import type { Diagnostic, Provenance, ScanOptions, Scope } from "./types.js";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested content omitted]";
  if (typeof value === "string")
    return value.replace(/(?:https?|ssh|git|file):\/\/[^\s"<>]+/gi, (input) => {
      try {
        const url = new URL(input);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        return "[invalid URL]";
      }
    });
  if (Array.isArray(value))
    return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (plainObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 200)
        .map(([key, val]) => [
          key,
          /token|secret|password|authorization|credential/i.test(key)
            ? "[redacted]"
            : redact(val, depth + 1),
        ]),
    );
  return value;
}
export interface LockData {
  path: string;
  schema: number;
  entries: Map<string, Provenance>;
  diagnostics: Diagnostic[];
}
export function lockPathFor(scope: Scope, options: ScanOptions): string {
  return scope.kind === "project"
    ? join(scope.path, "skills-lock.json")
    : options.xdgStateHome
      ? join(options.xdgStateHome, "skills/.skill-lock.json")
      : join(scope.path, ".agents/.skill-lock.json");
}
export async function readLock(
  scope: Scope,
  options: ScanOptions,
): Promise<LockData> {
  const path = lockPathFor(scope, options);
  const result: LockData = {
    path,
    schema: 0,
    entries: new Map(),
    diagnostics: [],
  };
  try {
    const content = await readBounded(path, 4 * 1024 * 1024);
    if (content.truncated) throw new Error("Lock too large");
    const data: unknown = JSON.parse(content.text);
    if (!plainObject(data) || !plainObject(data.skills))
      throw new Error("Invalid shape");
    const schema = Number(data.version);
    result.schema = schema;
    if (
      !(scope.kind === "global" ? schema === 3 : schema === 1 || schema === 2)
    ) {
      result.diagnostics.push({
        code: "LOCK_UNSUPPORTED",
        message: `锁文件格式 ${schema} 暂不支持；安装目录仍正常扫描。`,
        path,
      });
      return result;
    }
    for (const [key, original] of Object.entries(data.skills)) {
      if (!plainObject(original)) continue;
      const entry = redact(original) as Record<string, unknown>;
      const source = textField(entry.source);
      if (!source) continue;
      const hash = textField(
        scope.kind === "global" ? entry.skillFolderHash : entry.computedHash,
      );
      result.entries.set(key, {
        recordPath: path,
        recordKey: key,
        schema,
        source,
        sourceType: textField(entry.sourceType),
        sourceUrl: textField(entry.sourceUrl),
        skillPath: textField(entry.skillPath),
        originalName: textField(entry.skillName),
        ref: textField(entry.ref),
        commit: textField(entry.commit),
        installedAt: textField(entry.installedAt),
        updatedAt: textField(entry.updatedAt),
        hash: hash
          ? {
              algorithm:
                scope.kind === "global"
                  ? entry.skillFolderHashAlgorithm === "skills-content-v2"
                    ? "skills-content-v2"
                    : entry.sourceType === "github"
                      ? "git-tree"
                      : "upstream-folder-hash"
                  : `skills-content-v${schema}`,
              value: hash,
            }
          : undefined,
        record: entry,
      });
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT")
      result.diagnostics.push({
        code: "LOCK_UNREADABLE",
        message: "锁文件无法读取或格式损坏；不会将其作为空文件覆盖。",
        path,
      });
  }
  return result;
}
