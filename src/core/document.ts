import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { inside } from "./paths.js";
import type { Diagnostic } from "./types.js";

const MAX_DOCUMENT = 512 * 1024;
export function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : "UNKNOWN";
}
export function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function textField(value: unknown, max = 2048): string | undefined {
  return typeof value === "string" || typeof value === "number"
    ? String(value).slice(0, max)
    : undefined;
}
export async function readBounded(
  path: string,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile())
      throw Object.assign(new Error("Not a regular file"), {
        code: "NOT_REGULAR",
      });
    const buffer = Buffer.alloc(Math.min(stat.size, max) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return {
      text: buffer.subarray(0, Math.min(bytesRead, max)).toString("utf8"),
      truncated: bytesRead > max || stat.size > max,
    };
  } finally {
    await handle.close();
  }
}
export async function readDocument(root: string) {
  const diagnostics: Diagnostic[] = [];
  let raw = "";
  let truncated = false;
  try {
    const path = await realpath(join(root, "SKILL.md"));
    if (!inside(root, path))
      throw Object.assign(new Error("Document escapes skill directory"), {
        code: "OUTSIDE_ROOT",
      });
    ({ text: raw, truncated } = await readBounded(path, MAX_DOCUMENT));
    if (truncated)
      diagnostics.push({
        code: "DOCUMENT_LIMIT",
        message: "文档超过 512 KiB，仅展示前部分。",
      });
  } catch (error) {
    const missing = errorCode(error) === "ENOENT";
    diagnostics.push({
      code: missing ? "DOCUMENT_MISSING" : "DOCUMENT_UNREADABLE",
      message: missing
        ? "没有可读取的 SKILL.md。"
        : `无法读取 SKILL.md（${errorCode(error)}）。`,
    });
    return {
      raw,
      markdown: "",
      metadata: {} as Record<string, unknown>,
      diagnostics,
      truncated,
      state: missing ? ("missing" as const) : ("unreadable" as const),
    };
  }
  const match = raw
    .replace(/^\uFEFF/, "")
    .match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let metadata: Record<string, unknown> = {};
  if (!match)
    diagnostics.push({
      code: "FRONTMATTER_MISSING",
      message: "缺少有效的 YAML frontmatter，文档仍可阅读。",
    });
  else {
    try {
      const parsed: unknown = parse(match[1], {
        maxAliasCount: 20,
        uniqueKeys: true,
        logLevel: "silent",
      });
      if (!plainObject(parsed)) throw new Error("Invalid metadata");
      // A YAML alias may form a cycle. Keep the document readable without
      // handing non-serializable metadata to the API response.
      metadata = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    } catch {
      diagnostics.push({
        code: "FRONTMATTER_INVALID",
        message: "YAML 元数据无法解析，文档仍可阅读。",
      });
    }
  }
  if (
    !textField(metadata.name)?.trim() ||
    !textField(metadata.description)?.trim()
  )
    diagnostics.push({
      code: "METADATA_INCOMPLETE",
      message: "Skill 元数据缺少名称或描述。",
    });
  return {
    raw,
    markdown: match ? raw.replace(/^\uFEFF/, "").slice(match[0].length) : raw,
    metadata,
    diagnostics,
    truncated,
    state: diagnostics.length ? ("invalid" as const) : ("valid" as const),
  };
}
