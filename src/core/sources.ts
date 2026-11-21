import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readdir,
  realpath,
  rm,
  lstat,
  mkdir,
  copyFile,
  chmod,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { readDocument } from "./document.js";

const exec = promisify(execFile);
const skip = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  "__pypackages__",
  "metadata.json",
  ".DS_Store",
]);
export const safeName = (name: string) =>
  /^[a-z0-9][a-z0-9._-]{0,99}$/.test(name);
export interface SourceCandidate {
  name: string;
  description: string;
  path: string;
}
export interface PreparedSource {
  root: string;
  info: {
    source: string;
    sourceType: string;
    sourceUrl: string;
    ref?: string;
    commit?: string;
  };
  candidates: SourceCandidate[];
  treeHash(candidate: SourceCandidate): Promise<string>;
  dispose(): Promise<void>;
}
async function git(args: string[]): Promise<string> {
  const result = await exec(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "protocol.file.allow=never",
      ...args,
    ],
    {
      timeout: 90000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return result.stdout.trim();
}

export async function resolveSkillsSource(
  input: string,
  ref: string | undefined,
  cwd: string,
  home: string,
): Promise<PreparedSource> {
  if (!input.trim() || input.length > 2048 || /[\x00-\x1f]/.test(input))
    throw new Error("请输入 Git 仓库地址或本地 Skill 目录。");
  if (ref && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(ref))
    throw new Error("分支、标签或提交格式无效。");
  input = input.trim();
  let remote: string | undefined;
  let subpath = "";
  let sourceType = "local";
  let source = input;
  if (/^[\w.-]+\/[\w.-]+$/.test(input))
    remote = `https://github.com/${input}.git`;
  else if (/^(?:https?|git):\/\//i.test(input)) {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        "请使用不含凭据或查询参数的仓库地址；私有仓库使用本机 Git 凭据。",
      );
    if (url.hostname === "github.com") {
      const parts = url.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      if (parts.length < 2) throw new Error("请提供完整的 GitHub 仓库地址。");
      remote = `https://github.com/${parts[0]}/${parts[1].replace(/\.git$/, "")}.git`;
      if (parts[2] === "tree") {
        ref ??= parts[3];
        subpath = parts.slice(4).join("/");
      } else if (parts.length > 2)
        throw new Error("请使用仓库地址或 GitHub tree 目录地址。");
    } else remote = input;
  } else if (/^(?:git@[a-zA-Z0-9.-]+:[\w./-]+|ssh:\/\/[^\s]+)$/.test(input)) {
    if (input.startsWith("ssh://") && new URL(input).password)
      throw new Error("仓库地址不能包含密码。");
    remote = input;
  }
  let temporary: string | undefined;
  let root: string;
  let commit: string | undefined;
  try {
    if (ref && !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(ref))
      throw new Error("分支、标签或提交格式无效。");
    if (remote) {
      temporary = await mkdtemp(join(tmpdir(), "skills-console-source-"));
      root = join(temporary, "repository");
      await git([
        "clone",
        "--depth",
        "1",
        "--no-checkout",
        "--no-recurse-submodules",
        "--",
        remote,
        root,
      ]);
      if (ref)
        await git(["-C", root, "fetch", "--depth", "1", "--", "origin", ref]);
      await git([
        "-C",
        root,
        "checkout",
        "--detach",
        ref ? "FETCH_HEAD" : "HEAD",
      ]);
      commit = await git(["-C", root, "rev-parse", "HEAD"]);
      if (!ref)
        ref =
          (
            await git([
              "-C",
              root,
              "symbolic-ref",
              "--short",
              "refs/remotes/origin/HEAD",
            ]).catch(() => "")
          ).replace(/^origin\//, "") || undefined;
      sourceType = /github\.com[/:]/.test(remote)
        ? "github"
        : /gitlab\.com[/:]/.test(remote)
          ? "gitlab"
          : "git";
      source =
        sourceType === "github"
          ? remote.replace(/^.*github\.com[/:]/, "").replace(/\.git$/, "")
          : remote;
    } else {
      if (ref)
        throw new Error("本地目录直接复制当前内容，无需填写分支或标签。");
      root = await realpath(
        resolve(
          cwd,
          input.startsWith("~/") ? join(home, input.slice(2)) : input,
        ),
      );
      source = root;
    }
    const candidates: SourceCandidate[] = [];
    let visits = 0;
    async function discover(path: string, depth: number) {
      if (++visits > 3000 || candidates.length >= 200)
        throw new Error("来源目录过大，请输入更具体的 Skill 子目录。");
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      const doc = await readDocument(await realpath(path));
      if (doc.state === "valid") {
        const name = String(doc.metadata.name);
        if (!safeName(name))
          throw new Error(
            `Skill 名称「${name}」不适合作为安装目录，请使用小写字母、数字、点、下划线或连字符。`,
          );
        candidates.push({
          name,
          description: String(doc.metadata.description).slice(0, 4000),
          path,
        });
        return;
      }
      if (depth >= 6) return;
      for (const child of await readdir(path, { withFileTypes: true }))
        if (child.isDirectory() && !skip.has(child.name))
          await discover(join(path, child.name), depth + 1);
    }
    const searchRoot = resolve(root, subpath);
    if (relative(root, searchRoot).split(sep).includes(".."))
      throw new Error("Skill 子目录不在来源仓库内。");
    await discover(searchRoot, 0);
    if (!candidates.length)
      throw new Error(
        "该目录未发现有效的 SKILL.md（需要 name 和 description）。",
      );
    return {
      root,
      info: { source, sourceType, sourceUrl: remote ?? root, ref, commit },
      candidates,
      treeHash: (candidate) =>
        remote
          ? git([
              "-C",
              root,
              "rev-parse",
              relative(root, candidate.path)
                ? `${commit}:${relative(root, candidate.path).split(sep).join("/")}`
                : `${commit}^{tree}`,
            ])
          : Promise.resolve(""),
      dispose: async () => {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    if (error && typeof error === "object" && "stderr" in error)
      throw new Error(
        "Git 获取失败，请检查仓库地址、分支、网络和本机 Git 凭据。",
      );
    throw error;
  }
}

export async function stageSkill(
  source: string,
  target: string,
): Promise<void> {
  let bytes = 0,
    entries = 0;
  async function copy(from: string, to: string) {
    if (++entries > 2000)
      throw new Error("Skill 文件数量超过 2000 项，暂不支持安装。");
    const info = await lstat(from);
    if (info.isSymbolicLink())
      throw new Error("Skill 内包含软链接，请先整理为独立文件再安装。");
    if (info.isDirectory()) {
      await mkdir(to);
      for (const entry of await readdir(from))
        if (!skip.has(entry)) await copy(join(from, entry), join(to, entry));
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > 20 * 1024 * 1024)
        throw new Error("Skill 内容超过 20 MiB，暂不支持安装。");
      await copyFile(from, to);
      await chmod(to, info.mode & 0o777);
    } else throw new Error("Skill 包含非普通文件，无法安装。");
  }
  await copy(source, target);
}

export async function contentHash(
  root: string,
  schema: number,
): Promise<string> {
  const files: { path: string; bytes: Buffer }[] = [];
  async function collect(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (entry.isFile())
        files.push({
          path: relative(root, path).split(sep).join("/"),
          bytes: await readFile(path),
        });
    }
  }
  await collect(root);
  files.sort((a, b) =>
    schema === 1
      ? a.path.localeCompare(b.path)
      : Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
  );
  const hash = createHash("sha256");
  for (const file of files) {
    if (schema === 1) {
      hash.update(file.path);
      hash.update(file.bytes);
    } else {
      const bytes = file.bytes.includes(0)
        ? file.bytes
        : Buffer.from(
            file.bytes.toString("latin1").replaceAll("\r\n", "\n"),
            "latin1",
          );
      hash.update(file.path);
      hash.update("\0");
      hash.update(String(bytes.length));
      hash.update("\0");
      hash.update(bytes);
    }
  }
  return hash.digest("hex");
}
