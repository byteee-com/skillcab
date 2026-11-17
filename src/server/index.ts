import Fastify from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { getSkillDetail, scanSkills } from "../core/scanner.js";
import { errorCode, plainObject } from "../core/document.js";
import { ProjectStore } from "./projects.js";
import type { AppState, Inventory, ScanOptions } from "../core/types.js";

export interface ServerOptions extends Omit<ScanOptions, "project"> {
  projects?: string[];
  configPath?: string;
  token?: string;
  webDirectory?: string;
}
const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
export async function createServer(options: ServerOptions = {}) {
  const home = resolve(options.home ?? homedir());
  const token = options.token ?? randomBytes(32).toString("hex");
  const app = Fastify({ logger: false, bodyLimit: 8192 });
  const store = new ProjectStore(
    options.configPath ?? join(home, ".config/skills-console/config.json"),
    home,
  );
  await store.load(options.projects);
  const inventories = new Map<string, Inventory>();
  const pending = new Map<string, Promise<Inventory>>();
  const webDir =
    options.webDirectory ??
    join(dirname(fileURLToPath(import.meta.url)), "web");

  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (!/^127\.0\.0\.1(?::\d{1,5})?$/.test(host))
      return reply.code(403).send({ error: "仅允许本机回环地址访问。" });
    if (request.headers.origin && request.headers.origin !== `http://${host}`)
      return reply.code(403).send({ error: "不允许跨站访问。" });
    if (request.headers["sec-fetch-site"] === "cross-site")
      return reply.code(403).send({ error: "不允许跨站访问。" });
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (request.url.startsWith("/api/")) {
      const given =
        request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const supplied = Buffer.from(given);
      const expected = Buffer.from(token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      )
        return reply
          .code(401)
          .send({ error: "会话已失效。请从终端重新打开启动链接。" });
    }
  });
  async function inventory(scopeId: string): Promise<Inventory> {
    const existing = pending.get(scopeId);
    if (existing) return existing;
    const project =
      scopeId === "global"
        ? undefined
        : store.projects.find((p) => p.id === scopeId);
    if (scopeId !== "global" && !project)
      throw Object.assign(new Error("项目未登记。"), { code: "UNKNOWN_SCOPE" });
    const action = scanSkills({
      ...options,
      home,
      project: project?.path,
      additionalRoots: project ? undefined : options.additionalRoots,
    })
      .then((result) => {
        inventories.set(scopeId, result);
        return result;
      })
      .finally(() => pending.delete(scopeId));
    pending.set(scopeId, action);
    return action;
  }
  app.get(
    "/api/state",
    async (): Promise<AppState> => ({
      version: "0.1.0",
      home,
      projects: store.projects,
      configIssue: store.issue,
    }),
  );
  app.post("/api/projects", async (request, reply) => {
    if (
      !plainObject(request.body) ||
      typeof request.body.path !== "string" ||
      !request.body.path.trim() ||
      request.body.path.length > 4096
    )
      return reply.code(400).send({ error: "请输入有效的项目绝对路径。" });
    if (!/^(?:\/|[A-Za-z]:[\\/]|~\/)/.test(request.body.path))
      return reply
        .code(400)
        .send({ error: "请输入绝对路径或 ~/ 开头的路径。" });
    try {
      return await store.add(request.body.path.trim());
    } catch (error) {
      return reply.code(400).send({
        error:
          errorCode(error) === "ENOENT"
            ? "目录不存在，请检查路径。"
            : error instanceof Error && !("code" in error)
              ? error.message
              : "项目目录无法读取。",
      });
    }
  });
  app.get<{ Querystring: { scope?: string } }>(
    "/api/inventory",
    async (request, reply) => {
      const id = request.query.scope ?? "global";
      try {
        return await inventory(id);
      } catch (error) {
        return reply
          .code(errorCode(error) === "UNKNOWN_SCOPE" ? 404 : 500)
          .send({
            error:
              error instanceof Error ? error.message : "扫描失败，请重试。",
          });
      }
    },
  );
  app.get<{ Params: { id: string }; Querystring: { scope?: string } }>(
    "/api/skills/:id",
    async (request, reply) => {
      const id = request.query.scope ?? "global";
      let data = inventories.get(id);
      if (!data) {
        try {
          data = await inventory(id);
        } catch {
          return reply.code(404).send({ error: "未找到该扫描范围。" });
        }
      }
      const installation = data.installations.find(
        (item) => item.id === request.params.id,
      );
      if (!installation)
        return reply.code(404).send({ error: "Skill 已不在列表中，请刷新。" });
      try {
        return await getSkillDetail(installation);
      } catch {
        return reply
          .code(409)
          .send({ error: "安装位置已变化或无法读取，请刷新列表。" });
      }
    },
  );
  app.get("/", async (_request, reply) => {
    try {
      return reply
        .type("text/html")
        .send(await readFile(join(webDir, "index.html")));
    } catch {
      return reply
        .code(503)
        .type("text/plain")
        .send("Web UI 尚未构建。请在源码目录运行 pnpm build。");
    }
  });
  app.get<{ Params: { "*": string } }>("/assets/*", async (request, reply) => {
    const name = request.params["*"];
    if (!/^[a-zA-Z0-9_.-]+$/.test(name)) return reply.code(404).send();
    try {
      return reply
        .type(MIME[extname(name)] ?? "application/octet-stream")
        .send(await readFile(join(webDir, "assets", name)));
    } catch {
      return reply.code(404).send();
    }
  });
  return { app, token, store };
}
