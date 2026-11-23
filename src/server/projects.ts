import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { errorCode, plainObject, readBounded } from "../core/document.js";
import { stableId } from "../core/paths.js";
import type { Project } from "../core/types.js";

export async function projectAt(input: string, home: string): Promise<Project> {
  const path = await realpath(
    resolve(input.startsWith("~/") ? join(home, input.slice(2)) : input),
  );
  if (!(await stat(path)).isDirectory())
    throw new Error("请选择存在的项目目录。");
  if (path === (await realpath(home)))
    throw new Error("用户主目录用于全局扫描，请选择具体项目。");
  return { id: stableId(path), name: basename(path), path };
}

export class ProjectStore {
  projects: Project[] = [];
  issue?: string;
  private queue: Promise<unknown> = Promise.resolve();
  private observedContent?: string;
  constructor(
    readonly path: string,
    readonly home: string,
  ) {}
  async load(startupProjects: string[] = []) {
    let items: unknown[] = [];
    try {
      const raw = await readBounded(this.path, 128 * 1024);
      if (raw.truncated) throw new Error("配置文件过大");
      this.observedContent = raw.text;
      const parsed: unknown = JSON.parse(raw.text);
      if (
        !plainObject(parsed) ||
        parsed.version !== 1 ||
        !Array.isArray(parsed.projects)
      )
        throw new Error("配置格式不支持");
      items = parsed.projects.slice(0, 100);
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        )
      )
        this.issue =
          "项目配置读取失败。当前仍可查看；请检查配置后重启，暂不覆盖原文件。";
    }
    for (const item of items) {
      if (plainObject(item) && typeof item.path === "string") {
        // Keep missing projects visible; selecting one shows an explicit missing-root state.
        const path = resolve(item.path);
        this.projects.push({ id: stableId(path), name: basename(path), path });
      }
    }
    for (const input of startupProjects) {
      const project = await projectAt(input, this.home);
      if (!this.projects.some((p) => p.id === project.id))
        this.projects.push(project);
    }
    this.projects = [...new Map(this.projects.map((p) => [p.id, p])).values()];
  }
  async add(input: string): Promise<Project> {
    const [project] = await this.addMany([input]);
    return project;
  }
  async addMany(inputs: string[]): Promise<Project[]> {
    const resolved = await Promise.all(
      inputs.map(async (input) => {
        try {
          return await projectAt(input, this.home);
        } catch (error) {
          if (inputs.length === 1) throw error;
          const message =
            errorCode(error) === "ENOENT"
              ? "目录不存在"
              : error instanceof Error && !("code" in error)
                ? error.message
                : "目录无法读取";
          throw new Error(`${input}：${message}`);
        }
      }),
    );
    const selected = [...new Map(resolved.map((p) => [p.id, p])).values()];
    if (!selected.length) return selected;
    return this.enqueue(async () => {
      if (this.issue) throw new Error(this.issue);
      const known = new Set(this.projects.map((p) => p.id));
      const additions = selected.filter((p) => !known.has(p.id));
      if (!additions.length) return selected;
      const projects = [...this.projects, ...additions];
      if (projects.length > 100) throw new Error("最多登记 100 个项目。");
      await this.save(projects);
      this.projects = projects;
      return selected;
    });
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const promise = this.queue.then(action);
    this.queue = promise.catch(() => undefined);
    return promise;
  }
  private async save(projects: Project[]) {
    let current: string | undefined;
    try {
      const content = await readBounded(this.path, 128 * 1024);
      if (content.truncated) throw new Error("配置文件过大");
      current = content.text;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (current !== this.observedContent) {
      throw new Error("项目配置已被其他进程修改，请重启后重试；原文件已保留。");
    }
    const content =
      JSON.stringify(
        { version: 1, projects: projects.map((p) => ({ path: p.path })) },
        null,
        2,
      ) + "\n";
    if (Buffer.byteLength(content) > 128 * 1024)
      throw new Error("项目配置过大，请减少登记的目录数量。");
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temp, content, { mode: 0o600 });
    await rename(temp, this.path);
    this.observedContent = content;
  }
}
