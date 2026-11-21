import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownAZ,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Code2,
  Copy,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  Globe2,
  Layers3,
  Link2,
  Loader2,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api.js";
import type {
  AppState,
  Diagnostic,
  Installation,
  Inventory,
  Project,
  SkillDetail,
  ToolId,
} from "../core/types.js";
import "./styles.css";

const TOOLS: Record<ToolId, string> = {
  shared: "共享目录",
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  custom: "自定义",
};
const MANAGERS = {
  "skills-cli": "Skills CLI",
  local: "本地内容",
  external: "外部管理",
};
const relativeHome = (path: string, home: string) =>
  path === home
    ? "~"
    : path.startsWith(`${home}/`)
      ? `~${path.slice(home.length)}`
      : path;
const sourceName = (item: Installation) =>
  item.provenance?.source ?? MANAGERS[item.manager];
const hasIssue = (item: Installation) => item.diagnostics.length > 0;

function App() {
  const [state, setState] = useState<AppState>();
  const [scope, setScope] = useState("global");
  const [inventory, setInventory] = useState<Inventory>();
  const [globalInventory, setGlobalInventory] = useState<Inventory>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [tool, setTool] = useState("all");
  const [manager, setManager] = useState("all");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [includeGlobal, setIncludeGlobal] = useState(false);
  const [descending, setDescending] = useState(false);
  const [selected, setSelected] = useState<Installation>();
  const [addingProject, setAddingProject] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const home = state?.home ?? "";
  const project = state?.projects.find((p) => p.id === scope);

  useEffect(() => {
    const controller = new AbortController();
    api<AppState>("/state", { signal: controller.signal })
      .then(setState)
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error.message);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!state) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setInventory(undefined);
    setGlobalInventory(undefined);
    setSelected(undefined);
    const load = api<Inventory>(
      `/inventory?scope=${encodeURIComponent(scope)}`,
      { signal: controller.signal },
    );
    const global =
      scope === "global"
        ? Promise.resolve(undefined)
        : api<Inventory>("/inventory?scope=global", {
            signal: controller.signal,
          });
    Promise.all([load, global])
      .then(([current, global]) => {
        if (controller.signal.aborted) return;
        setInventory(current);
        setGlobalInventory(global);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // The project registry may update without changing the chosen scope.
  }, [scope, !!state, revision]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !(
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        )
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setSelected(undefined);
        setAddingProject(false);
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const items = useMemo(
    () => [
      ...(inventory?.installations ?? []),
      ...(includeGlobal ? (globalInventory?.installations ?? []) : []),
    ],
    [inventory, globalInventory, includeGlobal],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items
      .filter(
        (item) =>
          (!query ||
            `${item.name} ${item.directoryName} ${item.description} ${sourceName(item)}`
              .toLocaleLowerCase()
              .includes(query)) &&
          (tool === "all" ||
            item.locations.some(
              (location) =>
                location.tool === tool ||
                (location.tool === "shared" &&
                  ["codex", "cursor"].includes(tool)),
            )) &&
          (manager === "all" || item.manager === manager) &&
          (!issuesOnly || hasIssue(item)),
      )
      .sort((a, b) => (descending ? -1 : 1) * a.name.localeCompare(b.name));
  }, [items, search, tool, manager, issuesOnly, descending]);
  const issueCount = items.filter(hasIssue).length;
  function chooseScope(id: string) {
    setScope(id);
    setSearch("");
    setTool("all");
    setManager("all");
    setIssuesOnly(false);
    setIncludeGlobal(false);
    setSidebarOpen(false);
    setShowScan(false);
  }
  const resetFilters = () => {
    setSearch("");
    setTool("all");
    setManager("all");
    setIssuesOnly(false);
  };

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-shade"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">
            <Layers3 size={19} strokeWidth={1.8} />
          </span>
          <div>
            Skills Console<span>本机只读工作区</span>
          </div>
        </div>
        <button
          className={`nav-item ${scope === "global" ? "active" : ""}`}
          onClick={() => chooseScope("global")}
        >
          <Globe2 size={17} />
          <span>全局 Skills</span>
          {scope === "global" && inventory && (
            <span className="nav-count">{inventory.installations.length}</span>
          )}
        </button>
        <div className="nav-section-label projects-label">
          项目{" "}
          <button
            title="添加项目"
            aria-label="添加项目"
            onClick={() => setAddingProject(true)}
          >
            <Plus size={16} />
          </button>
        </div>
        <nav aria-label="项目列表" className="project-nav">
          {state?.projects.map((item) => (
            <button
              key={item.id}
              className={`nav-item project-item ${scope === item.id ? "active" : ""}`}
              onClick={() => chooseScope(item.id)}
              title={item.path}
            >
              <Folder size={16} />
              <span>{item.name}</span>
              {scope === item.id && <span className="nav-dot" />}
            </button>
          ))}
          {!state?.projects.length && (
            <div className="no-projects">
              把项目加入工作区，查看它自己的 Skills。
            </div>
          )}
        </nav>
        <button
          className="add-project-button"
          onClick={() => setAddingProject(true)}
        >
          <Plus size={14} /> 添加项目
        </button>
        <div className="sidebar-bottom">
          <div className="local-status">
            <i /> 本机运行 <span>v{state?.version ?? "0.1.0"}</span>
          </div>
          <div className="privacy-note">
            <ShieldCheck size={13} /> 只读扫描，保留现有安装
          </div>
        </div>
      </aside>

      <main className={`workspace ${selected ? "has-selection" : ""}`}>
        <header className="workspace-heading">
          <button
            className="mobile-menu icon-button"
            aria-label="打开导航"
            onClick={() => setSidebarOpen(true)}
          >
            <PanelLeftClose size={18} />
          </button>
          <div className="title-block">
            <h1>{project?.name ?? "全局 Skills"}</h1>
            <div className="scope-path" title={project?.path ?? home}>
              <FolderOpen size={12} />
              <code>{relativeHome(project?.path ?? home, home)}</code>
            </div>
          </div>
          <button
            className="refresh-button"
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spinning" : ""} /> 刷新
            <span className="hide-small">扫描</span>
          </button>
        </header>
        <div className="inventory-summary" aria-label="盘点概览">
          <span>
            <strong>
              {filtered.length === items.length
                ? items.length
                : `${filtered.length} / ${items.length}`}
            </strong>{" "}
            份安装
          </span>
          <span>
            <i className="tiny-dot teal" />
            <strong>
              {items.filter((i) => i.manager === "skills-cli").length}
            </strong>{" "}
            CLI 记录
          </span>
          <span>
            <i className="tiny-dot gray" />
            <strong>
              {items.filter((i) => i.manager === "local").length}
            </strong>{" "}
            本地内容
          </span>
          <button
            className={issuesOnly ? "summary-active" : ""}
            onClick={() => setIssuesOnly((v) => !v)}
            aria-pressed={issuesOnly}
          >
            <TriangleAlert size={13} />
            <strong>{issueCount}</strong> 需留意
          </button>
        </div>
        <div className="inventory-body">
          <section className="list-panel" aria-label="Skill 列表">
            <div className="list-toolbar">
              <div className="search-box">
                <Search size={15} />
                <input
                  ref={searchRef}
                  aria-label="搜索 Skills"
                  placeholder="搜索名称、描述或来源…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <kbd>/</kbd>
              </div>
              <label>
                <span className="sr-only">按工具筛选</span>
                <select value={tool} onChange={(e) => setTool(e.target.value)}>
                  <option value="all">所有工具</option>
                  {Object.entries(TOOLS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="sr-only">按来源筛选</span>
                <select
                  value={manager}
                  onChange={(e) => setManager(e.target.value)}
                >
                  <option value="all">所有来源</option>
                  {Object.entries(MANAGERS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="icon-button sort-button"
                onClick={() => setDescending((v) => !v)}
                title={descending ? "切换为名称升序" : "切换为名称降序"}
                aria-label={descending ? "切换为名称升序" : "切换为名称降序"}
              >
                <ArrowDownAZ size={16} />
              </button>
            </div>
            {scope !== "global" && (
              <label className="global-toggle">
                <input
                  type="checkbox"
                  checked={includeGlobal}
                  onChange={(e) => setIncludeGlobal(e.target.checked)}
                />{" "}
                包含全局可见候选{" "}
                <CircleHelp
                  size={13}
                  aria-label="表示目录规则下的候选，不代表实际调用"
                />
              </label>
            )}
            {state?.configIssue && (
              <div className="notice error-notice">{state.configIssue}</div>
            )}
            {inventory &&
              (inventory.diagnostics.length > 0 || inventory.truncated) && (
                <button
                  className="scan-notice"
                  onClick={() => setShowScan((v) => !v)}
                  aria-expanded={showScan}
                >
                  <TriangleAlert size={14} />
                  <span>
                    {inventory.diagnostics.length} 条扫描提示
                    {inventory.truncated ? " · 列表不完整" : ""}
                  </span>
                  <ChevronRight
                    size={14}
                    className={showScan ? "rotate" : ""}
                  />
                </button>
              )}
            {showScan && inventory && (
              <div className="scan-diagnostics">
                <Diagnostics items={inventory.diagnostics} />
              </div>
            )}
            <div className="skill-list-scroll">
              {loading ? (
                <div className="empty-state">
                  <Loader2 className="spinning" size={24} />
                  <h2>正在读取本机目录</h2>
                  <p>扫描安装位置与来源记录…</p>
                </div>
              ) : error ? (
                <div className="empty-state">
                  <TriangleAlert size={26} />
                  <h2>暂时无法读取</h2>
                  <p>{error}</p>
                  <button
                    className="secondary-button"
                    onClick={() => setRevision((v) => v + 1)}
                  >
                    重新扫描
                  </button>
                </div>
              ) : filtered.length === 0 ? (
                <div className="empty-state">
                  <FolderOpen size={30} />
                  <h2>
                    {items.length
                      ? "没有匹配的 Skills"
                      : "这个范围还没有 Skills"}
                  </h2>
                  <p>
                    {items.length
                      ? "试试其他关键词，或调整筛选条件。"
                      : "已检查配置目录；也可以查看下面的扫描位置。"}
                  </p>
                  {items.length > 0 && (
                    <button className="secondary-button" onClick={resetFilters}>
                      清除筛选
                    </button>
                  )}
                </div>
              ) : (
                <ul className="skill-list">
                  {filtered.map((item) => (
                    <li key={item.id}>
                      <button
                        className={`skill-row ${selected?.id === item.id ? "selected" : ""}`}
                        onClick={() => setSelected(item)}
                        aria-pressed={selected?.id === item.id}
                      >
                        <span
                          className={`skill-icon ${hasIssue(item) ? "has-issue" : ""}`}
                        >
                          {hasIssue(item) ? (
                            <TriangleAlert size={15} aria-label="需留意" />
                          ) : (
                            <FileCode2 size={15} strokeWidth={1.7} />
                          )}
                        </span>
                        <span className="skill-row-content">
                          <span className="skill-row-top">
                            <span className="skill-name">
                              {item.name}
                              {item.scope.kind === "global" &&
                                scope !== "global" && (
                                  <span className="scope-tag">全局</span>
                                )}
                            </span>
                            <span className="skill-row-meta">
                              <span className={`manager-dot ${item.manager}`} />
                              {sourceName(item)}
                              <span className="meta-separator">·</span>
                              {[
                                ...new Set(
                                  item.locations.map((l) => TOOLS[l.tool]),
                                ),
                              ].join(" / ")}
                            </span>
                          </span>
                          <span className="skill-description">
                            {item.description ||
                              "暂无描述 · 查看详情了解安装状态"}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="list-footer">
              <button
                onClick={() => setShowScan((v) => !v)}
                aria-expanded={showScan}
              >
                <Folder size={12} />{" "}
                {inventory?.roots.filter((r) => r.state === "present").length ??
                  0}{" "}
                个安装目录
              </button>
              <span>
                {inventory
                  ? `${new Date(inventory.scannedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 扫描`
                  : "本地文件系统"}
              </span>
            </div>
            {showScan && inventory && (
              <div className="root-list">
                {inventory.roots.map((root) => (
                  <div key={root.path}>
                    <span
                      className={`tiny-dot ${root.state === "present" ? "teal" : "gray"}`}
                    />
                    <code>{relativeHome(root.path, home)}</code>
                    <span>
                      {root.state === "present"
                        ? "已读取"
                        : root.state === "missing"
                          ? "不存在"
                          : "读取失败"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <aside
            className={`detail-panel ${selected ? "detail-open" : ""}`}
            aria-label="Skill 详情"
          >
            {selected ? (
              <Detail
                key={selected.id}
                item={selected}
                apiScope={selected.scope.kind === "global" ? "global" : scope}
                home={home}
                onClose={() => setSelected(undefined)}
              />
            ) : (
              <div className="detail-placeholder">
                <div className="placeholder-icon">
                  <Code2 size={22} strokeWidth={1.5} />
                </div>
                <h2>选择一个 Skill</h2>
                <p>查看文档、安装位置与已有的版本记录。</p>
              </div>
            )}
          </aside>
        </div>
      </main>
      {addingProject && (
        <AddProject
          home={home}
          onClose={() => setAddingProject(false)}
          onAdded={(item) => {
            setState((current) =>
              current
                ? {
                    ...current,
                    projects: current.projects.some((p) => p.id === item.id)
                      ? current.projects
                      : [...current.projects, item],
                  }
                : current,
            );
            chooseScope(item.id);
            setAddingProject(false);
          }}
        />
      )}
    </div>
  );
}

function Diagnostics({ items }: { items: Diagnostic[] }) {
  return (
    <ul className="diagnostic-list">
      {items.map((item, index) => (
        <li key={`${item.code}-${index}`}>
          <TriangleAlert size={13} />
          <div>
            {item.message}
            {item.path && <code>{item.path}</code>}
          </div>
        </li>
      ))}
    </ul>
  );
}

function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      className="icon-button copy-button"
      aria-label={copied ? "已复制" : "复制路径"}
      title={
        failed ? "复制失败，请手动选择路径" : copied ? "已复制" : "复制路径"
      }
      onClick={() => {
        navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          })
          .catch(() => setFailed(true));
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function Detail({
  item,
  apiScope,
  home,
  onClose,
}: {
  item: Installation;
  apiScope: string;
  home: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SkillDetail>();
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"document" | "installation" | "files">(
    "document",
  );
  useEffect(() => {
    const controller = new AbortController();
    api<SkillDetail>(
      `/skills/${item.id}?scope=${encodeURIComponent(apiScope)}`,
      { signal: controller.signal },
    )
      .then(setDetail)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [item.id, apiScope]);
  const p = item.provenance;
  return (
    <>
      <div className="detail-heading">
        <div className="detail-title">
          <h2>{item.name}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭详情"
          >
            <X size={17} />
          </button>
        </div>
        <div className="detail-badges">
          <span
            className={`badge ${item.manager === "skills-cli" ? "badge-teal" : ""}`}
          >
            {MANAGERS[item.manager]}
          </span>
          <span className="badge">
            {item.locations.some((l) => l.kind === "symlink")
              ? "链接安装"
              : "目录安装"}
          </span>
          {item.declaredVersion && (
            <span className="badge">声明版本 {item.declaredVersion}</span>
          )}
        </div>
        <p>
          {item.description ||
            "此 Skill 暂无有效描述。安装信息和原始文档仍可查看。"}
        </p>
      </div>
      <div
        className="detail-tabs"
        role="tablist"
        aria-label="详情内容"
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const tabs = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button"),
          );
          const index = tabs.indexOf(event.target as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : (index +
                    (event.key === "ArrowRight" ? 1 : -1) +
                    tabs.length) %
                  tabs.length;
          tabs[next]?.focus();
          tabs[next]?.click();
        }}
      >
        {(
          [
            ["document", "文档"],
            ["installation", "安装与来源"],
            ["files", "文件"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            aria-controls={`panel-${key}`}
            id={`tab-${key}`}
            onClick={() => setTab(key)}
          >
            {label}
            {key === "files" && detail && <span>{detail.files.length}</span>}
          </button>
        ))}
      </div>
      <div
        className="detail-scroll"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {error ? (
          <div className="notice error-notice">
            {error}
            <button className="text-button" onClick={onClose}>
              返回列表
            </button>
          </div>
        ) : !detail ? (
          <div className="detail-loading">
            <Loader2 className="spinning" size={19} /> 正在读取详情…
          </div>
        ) : tab === "document" ? (
          <>
            <Diagnostics
              items={[...item.diagnostics, ...detail.diagnostics].filter(
                (value, index, all) =>
                  all.findIndex(
                    (d) => d.code === value.code && d.path === value.path,
                  ) === index,
              )}
            />
            {detail.markdown ? (
              <article className="markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    a: ({ href, children }) =>
                      href && /^(https?:|mailto:)/.test(href) ? (
                        <a
                          href={href}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          {children}
                          <ArrowUpRight size={11} />
                        </a>
                      ) : (
                        <span>{children}</span>
                      ),
                    img: ({ alt }) => (
                      <span className="image-placeholder">
                        [图片：{alt || "未加载外部资源"}]
                      </span>
                    ),
                  }}
                >
                  {detail.markdown}
                </ReactMarkdown>
              </article>
            ) : (
              <div className="empty-document">
                <File size={24} />
                <p>没有可读取的文档正文</p>
                <button
                  className="text-button"
                  onClick={() => setTab("installation")}
                >
                  查看安装诊断 <ChevronRight size={13} />
                </button>
              </div>
            )}
            {detail.truncated && (
              <div className="notice">
                内容达到展示上限，部分文件或文档未展开。
              </div>
            )}
          </>
        ) : tab === "files" ? (
          <>
            <div className="section-kicker">
              资源清单 <span>只读 · 不跟随内部链接</span>
            </div>
            <div className="file-list">
              {detail.files.map((file) => (
                <div key={file.path}>
                  {file.kind === "symlink" ? (
                    <Link2 size={14} />
                  ) : (
                    <File size={14} />
                  )}
                  <code>{file.path}</code>
                  <span>
                    {file.kind === "symlink"
                      ? "链接"
                      : file.size === undefined
                        ? ""
                        : file.size < 1024
                          ? `${file.size} B`
                          : `${(file.size / 1024).toFixed(1)} KB`}
                  </span>
                </div>
              ))}
            </div>
            {!detail.files.length && (
              <p className="muted">没有可展示的资源文件。</p>
            )}
            {detail.truncated && (
              <div className="notice">
                文件清单最多展示 300 项、6 层目录，内容可能不完整。
              </div>
            )}
            <Diagnostics items={detail.diagnostics} />
          </>
        ) : (
          <>
            <div className="section-kicker">
              安装位置 <span>{item.locations.length} 个入口</span>
            </div>
            {item.locations.map((location) => (
              <div className="location-card" key={location.path}>
                <div className="location-label">
                  <span>
                    {location.kind === "symlink" ? (
                      <Link2 size={13} />
                    ) : (
                      <Folder size={13} />
                    )}
                    {TOOLS[location.tool]}
                  </span>
                  <span>
                    {location.kind === "broken"
                      ? "无法读取"
                      : location.kind === "symlink"
                        ? "软链接"
                        : "目录"}
                  </span>
                </div>
                <div className="copy-line">
                  <code>{relativeHome(location.path, home)}</code>
                  <CopyValue value={location.path} />
                </div>
                {location.linkTarget && (
                  <div className="link-destination">
                    <ArrowDownAZ size={12} />
                    <code>{relativeHome(location.linkTarget, home)}</code>
                  </div>
                )}
              </div>
            ))}
            {item.realPath && (
              <div className="info-field">
                <span>真实内容位置</span>
                <div className="copy-line">
                  <code>{relativeHome(item.realPath, home)}</code>
                  <CopyValue value={item.realPath} />
                </div>
              </div>
            )}
            <div className="section-kicker">来源与版本记录</div>
            <dl className="metadata-list">
              <dt>来源</dt>
              <dd>{p?.source ?? "来源未知，可在后续版本中关联"}</dd>
              {p?.sourceUrl && (
                <>
                  <dt>来源地址</dt>
                  <dd>
                    <code>{p.sourceUrl}</code>
                  </dd>
                </>
              )}
              <dt>声明版本</dt>
              <dd>
                {item.declaredVersion ?? "未声明"}
                <span className="field-note">作者元数据，不代表已核验版本</span>
              </dd>
              <dt>跟踪目标</dt>
              <dd>{p?.ref ?? "未记录"}</dd>
              <dt>安装提交</dt>
              <dd>
                <code>{p?.commit ?? "未记录"}</code>
                {p?.commit && (
                  <span className="field-note">来自锁记录，尚未重放核验</span>
                )}
              </dd>
              {p?.hash && (
                <>
                  <dt>记录指纹</dt>
                  <dd>
                    <code>{p.hash.value}</code>
                    <span className="field-note">{p.hash.algorithm}</span>
                  </dd>
                </>
              )}
              <dt>远端检查</dt>
              <dd>
                <span className="status-unknown">未检查</span>
                <span className="field-note">
                  本版本仅盘点本地安装，未请求上游
                </span>
              </dd>
              {item.author && (
                <>
                  <dt>作者</dt>
                  <dd>{item.author}</dd>
                </>
              )}
            </dl>
            {p && (
              <details className="lock-details">
                <summary>
                  锁文件记录 <code>schema {p.schema}</code>
                </summary>
                <div className="info-field">
                  <span>{p.recordPath}</span>
                  <pre>{JSON.stringify(p.record, null, 2)}</pre>
                </div>
              </details>
            )}
            <Diagnostics items={item.diagnostics} />
          </>
        )}
      </div>
      <div className="detail-footer">
        <ShieldCheck size={12} /> 读取现有文件，未改动安装内容
      </div>
    </>
  );
}

function AddProject({
  home,
  onClose,
  onAdded,
}: {
  home: string;
  onClose: () => void;
  onAdded: (project: Project) => void;
}) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      className="project-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setPending(true);
          setError("");
          api<Project>("/projects", {
            method: "POST",
            body: JSON.stringify({ path }),
          })
            .then(onAdded)
            .catch((error) => setError(error.message))
            .finally(() => setPending(false));
        }}
      >
        <div className="dialog-top">
          <span className="detail-symbol">
            <FolderOpen size={23} />
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭添加项目"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <h2>添加项目</h2>
        <p>
          登记一个本机目录，查看它的 Skill 安装。
          <br />
          项目内的文件和配置保持原样。
        </p>
        <label htmlFor="project-path">项目目录</label>
        <input
          autoFocus
          id="project-path"
          placeholder={`${home || "~"}/Code/my-project`}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          required
          autoComplete="off"
        />
        <span className="input-note">支持绝对路径或 ~/ 开头的路径</span>
        {error && (
          <div className="notice error-notice" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" disabled={pending}>
            {pending ? (
              <Loader2 size={14} className="spinning" />
            ) : (
              <Plus size={14} />
            )}
            添加项目
          </button>
        </div>
      </form>
    </dialog>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
