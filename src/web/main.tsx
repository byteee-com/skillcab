import {
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownAZ,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Copy,
  File,
  Folder,
  FolderOpen,
  Globe2,
  LayoutGrid,
  Layers3,
  Link2,
  List,
  Loader2,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolLogo } from "./ToolLogos.js";
import { UpdateBadge, SourceDialog, versionLabel } from "./VersionUI.js";
import { api } from "./api.js";
import { droppedProjectPaths } from "./project-drop.js";
import {
  InstallDialog,
  UninstallDialog,
  OperationNotice,
} from "./OperationDialogs.js";
import type { OperationResult } from "../core/operations.js";
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
  item.provenance?.source ?? item.tracking?.source ?? MANAGERS[item.manager];
const hasIssue = (item: Installation) => item.diagnostics.length > 0;
const hue = (name: string) =>
  [...name].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) % 360, 7);
const monogram = (name: string) =>
  name
    .replace(/[^a-z0-9]/gi, "")
    .charAt(0)
    .toUpperCase() || "S";
const VIEW_KEY = "skills-console:view";

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
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [includeGlobal, setIncludeGlobal] = useState(false);
  const [descending, setDescending] = useState(false);
  const [selected, setSelected] = useState<Installation>();
  const [projectDialog, setProjectDialog] = useState<{
    paths: string;
    note?: string;
  }>();
  const [projectError, setProjectError] = useState("");
  const [projectPending, setProjectPending] = useState(false);
  const [projectDropActive, setProjectDropActive] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [uninstalling, setUninstalling] = useState<Installation>();
  const [operation, setOperation] = useState<OperationResult>();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showScan, setShowScan] = useState(false);
  const [view, setView] = useState<"cards" | "list">(() =>
    localStorage.getItem(VIEW_KEY) === "list" ? "list" : "cards",
  );
  const searchRef = useRef<HTMLInputElement>(null);
  const projectBusy = useRef(false);
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
  useEffect(() => localStorage.setItem(VIEW_KEY, view), [view]);
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
        if (document.querySelector("dialog[open]")) return;
        setSelected(undefined);
        setProjectDialog(undefined);
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
          (!issuesOnly || hasIssue(item)) &&
          (!updatesOnly || item.update?.status === "available"),
      )
      .sort((a, b) => (descending ? -1 : 1) * a.name.localeCompare(b.name));
  }, [items, search, tool, manager, issuesOnly, updatesOnly, descending]);
  const issueCount = items.filter(hasIssue).length;
  function chooseScope(id: string) {
    setScope(id);
    setSearch("");
    setTool("all");
    setManager("all");
    setIssuesOnly(false);
    setUpdatesOnly(false);
    setIncludeGlobal(false);
    setSidebarOpen(false);
    setShowScan(false);
  }
  const resetFilters = () => {
    setSearch("");
    setTool("all");
    setManager("all");
    setIssuesOnly(false);
    setUpdatesOnly(false);
  };

  function replaceUpdated(updated: Installation) {
    const replace = (value: Inventory | undefined) =>
      value
        ? {
            ...value,
            installations: value.installations.map((i) =>
              i.id === updated.id ? updated : i,
            ),
          }
        : value;
    setInventory(replace);
    setGlobalInventory(replace);
    setSelected((current) => (current?.id === updated.id ? updated : current));
  }
  async function checkUpdates() {
    setChecking(true);
    setCheckError("");
    try {
      const result = await api<Inventory>(
        `/updates/check?scope=${encodeURIComponent(scope)}`,
        { method: "POST" },
      );
      setInventory(result);
      if (includeGlobal && scope !== "global")
        setGlobalInventory(
          await api<Inventory>("/updates/check?scope=global", {
            method: "POST",
          }),
        );
    } catch (error) {
      setCheckError((error as Error).message);
    } finally {
      setChecking(false);
    }
  }
  function onApplied(result: OperationResult) {
    setInstalling(false);
    setUninstalling(undefined);
    setSelected(undefined);
    chooseScope(result.scopeId);
    setRevision((v) => v + 1);
    setOperation(result);
  }
  function openProjectDialog(paths = "", note?: string) {
    setProjectError("");
    setProjectDialog({ paths, note });
  }
  async function addProjects(paths?: string[]) {
    if (projectBusy.current) return;
    projectBusy.current = true;
    setProjectPending(true);
    setProjectError("");
    try {
      const projects = await api<Project[]>(
        paths ? "/projects/batch" : "/projects/pick",
        {
          method: "POST",
          body: paths ? JSON.stringify({ paths }) : undefined,
        },
      );
      if (!projects.length) return;
      setState((current) => {
        if (!current) return current;
        const registered = new Map(current.projects.map((p) => [p.id, p]));
        for (const item of projects) registered.set(item.id, item);
        return { ...current, projects: [...registered.values()] };
      });
      setProjectDialog(undefined);
      chooseScope(projects[0].id);
    } catch (error) {
      setProjectError((error as Error).message);
    } finally {
      projectBusy.current = false;
      setProjectPending(false);
    }
  }
  function dropProjects(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setProjectDropActive(false);
    if (projectBusy.current) return;
    const transfer = event.dataTransfer;
    const paths = droppedProjectPaths(transfer);
    if (paths.length) {
      openProjectDialog(paths.join("\n"));
      void addProjects(paths);
      return;
    }
    const entries = Array.from(transfer.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.webkitGetAsEntry?.());
    if (
      transfer.types.includes("Files") &&
      (!entries.length || entries.some((entry) => !entry || entry.isDirectory))
    ) {
      openProjectDialog(
        "",
        state?.projectPicker
          ? "浏览器只提供文件夹名称。请在系统窗口中选择要添加的文件夹。"
          : "浏览器只提供文件夹名称。请粘贴这些文件夹的完整路径。",
      );
      if (state?.projectPicker) void addProjects();
    } else {
      openProjectDialog("", "请拖入项目文件夹或粘贴项目路径。");
    }
  }
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
            skillcab<span>本机 Skill 工作区</span>
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
            onClick={() => openProjectDialog()}
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
          className={`add-project-button${projectDropActive ? " is-dropping" : ""}`}
          aria-label="添加项目"
          onClick={() => openProjectDialog()}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setProjectDropActive(true);
          }}
          onDragLeave={() => setProjectDropActive(false)}
          onDrop={dropProjects}
        >
          <Plus size={14} /> 添加项目
          <span className="project-drop-hint" aria-hidden="true">
            {projectDropActive ? "松开添加" : "拖入文件夹"}
          </span>
        </button>
        <div className="sidebar-bottom">
          <div className="local-status">
            <i /> 本机运行 {state && <span>v{state.version}</span>}
          </div>
          <div className="privacy-note">
            <ShieldCheck size={13} /> 扫描只读，操作先确认
          </div>
        </div>
      </aside>

      <main className="workspace">
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
            className="primary-button install-button"
            aria-label="安装 Skill"
            onClick={() => setInstalling(true)}
          >
            <Plus size={14} />
            <span className="hide-small">安装 Skill</span>
          </button>
          <button
            className="secondary-button check-updates-button"
            onClick={() => void checkUpdates()}
            disabled={loading || checking}
          >
            <RefreshCw size={14} className={checking ? "spinning" : ""} />
            <span>{checking ? "检查中…" : "检查更新"}</span>
          </button>
          <button
            className="refresh-button"
            onClick={() => setRevision((value) => value + 1)}
            disabled={loading}
          >
            <RefreshCw size={14} className={loading ? "spinning" : ""} /> 刷新
            <span className="hide-small">扫描</span>
          </button>
        </header>
        {checkError && (
          <div className="notice error-notice" role="alert">
            {checkError}
          </div>
        )}
        {operation && (
          <OperationNotice
            key={operation.id}
            result={operation}
            onUndo={() => {
              setOperation(undefined);
              setRevision((v) => v + 1);
            }}
            onDismiss={() => setOperation(undefined)}
          />
        )}
        <div className="inventory-summary" aria-label="盘点概览">
          <div className="stat">
            <span>安装总数</span>
            <strong>
              {filtered.length === items.length
                ? items.length
                : `${filtered.length} / ${items.length}`}
            </strong>
          </div>
          <div className="stat">
            <span>
              <i className="tiny-dot teal" /> CLI 记录
            </span>
            <strong>
              {items.filter((i) => i.manager === "skills-cli").length}
            </strong>
          </div>
          <div className="stat">
            <span>
              <i className="tiny-dot gray" /> 本地内容
            </span>
            <strong>{items.filter((i) => i.manager === "local").length}</strong>
          </div>
          <button
            className={`stat stat-warn ${issuesOnly ? "summary-active" : ""}`}
            onClick={() => setIssuesOnly((v) => !v)}
            aria-pressed={issuesOnly}
          >
            <span>
              <TriangleAlert size={12} /> 需留意
            </span>
            <strong>{issueCount}</strong>
          </button>
          <button
            className={`stat ${updatesOnly ? "summary-active" : ""}`}
            onClick={() => setUpdatesOnly((v) => !v)}
            aria-pressed={updatesOnly}
            aria-label="只看有更新"
          >
            <span>
              <RefreshCw size={12} /> 有更新
            </span>
            <strong>
              {items.filter((i) => i.update?.status === "available").length}
            </strong>
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
              <div className="view-toggle" role="group" aria-label="视图">
                <button
                  aria-label="卡片视图"
                  title="卡片视图"
                  aria-pressed={view === "cards"}
                  onClick={() => setView("cards")}
                >
                  <LayoutGrid size={15} />
                </button>
                <button
                  aria-label="列表视图"
                  title="列表视图"
                  aria-pressed={view === "list"}
                  onClick={() => setView("list")}
                >
                  <List size={15} />
                </button>
              </div>
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
                <ul
                  className={`skill-list ${view === "cards" ? "is-cards" : ""}`}
                >
                  {filtered.map((item) => (
                    <li key={item.id}>
                      <SkillItem
                        item={item}
                        card={view === "cards"}
                        selected={selected?.id === item.id}
                        showScope={
                          item.scope.kind === "global" && scope !== "global"
                        }
                        onSelect={() => setSelected(item)}
                      />
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
        </div>
      </main>
      {selected && (
        <div className="drawer-layer">
          <div
            className="drawer-backdrop"
            aria-hidden="true"
            onClick={() => setSelected(undefined)}
          />
          <aside className="detail-drawer" aria-label="Skill 详情">
            <Detail
              key={selected.id}
              item={selected}
              apiScope={selected.scope.kind === "global" ? "global" : scope}
              home={home}
              onUpdated={replaceUpdated}
              onUninstall={() => setUninstalling(selected)}
              onClose={() => setSelected(undefined)}
            />
          </aside>
        </div>
      )}
      {installing && (
        <InstallDialog
          scopeId={scope}
          projects={state?.projects ?? []}
          onClose={() => setInstalling(false)}
          onApplied={onApplied}
        />
      )}
      {uninstalling && (
        <UninstallDialog
          item={uninstalling}
          scopeId={uninstalling.scope.kind === "global" ? "global" : scope}
          onClose={() => setUninstalling(undefined)}
          onApplied={onApplied}
        />
      )}
      {projectDialog && (
        <AddProject
          {...projectDialog}
          home={home}
          pending={projectPending}
          error={projectError}
          onClose={() => setProjectDialog(undefined)}
          onPaths={(paths) => {
            setProjectDialog({ ...projectDialog, paths });
            setProjectError("");
          }}
          onSubmit={(paths) => void addProjects(paths)}
          onPick={state?.projectPicker ? () => void addProjects() : undefined}
        />
      )}
    </div>
  );
}

function SkillItem({
  item,
  card,
  selected,
  showScope,
  onSelect,
}: {
  item: Installation;
  card: boolean;
  selected: boolean;
  showScope: boolean;
  onSelect: () => void;
}) {
  const issue = hasIssue(item);
  const icon = (
    <span className="skill-icon" aria-hidden="true">
      {monogram(item.name)}
    </span>
  );
  const name = (
    <span className="skill-name">
      {item.name}
      {showScope && <span className="scope-tag">全局</span>}
    </span>
  );
  const meta = (
    <span className="skill-row-meta">
      <span className={`manager-dot ${item.manager}`} />
      <span className="source-label">{sourceName(item)}</span>
      <span className="tool-logos">
        {[...new Set(item.locations.map((l) => l.tool))].map((t) => (
          <ToolLogo key={t} tool={t} />
        ))}
      </span>
    </span>
  );
  const description = (
    <span className="skill-description">
      {item.description || "暂无描述 · 查看详情了解安装状态"}
    </span>
  );
  return (
    <button
      className={`${card ? "skill-card" : "skill-row"} ${selected ? "selected" : ""}`}
      onClick={onSelect}
      aria-pressed={selected}
      style={{ "--hue": hue(item.name) } as CSSProperties}
    >
      {card ? (
        <>
          <span className="card-head">
            {icon}
            {name}
            {issue && (
              <span className="issue-pill">
                <TriangleAlert size={11} aria-label="需留意" /> 留意
              </span>
            )}
          </span>
          {description}
          <span className="skill-version-line">
            <span title="作者声明版本、锁记录提交或关联时核验提交">
              {versionLabel(item)}
            </span>
            <UpdateBadge item={item} />
          </span>
          {meta}
        </>
      ) : (
        <>
          {icon}
          <span className="skill-row-content">
            <span className="skill-row-top">
              {name}
              <span className="skill-version-line">
                <span>{versionLabel(item)}</span>
                <UpdateBadge item={item} />
              </span>
              {meta}
            </span>
            {description}
          </span>
          {issue && (
            <TriangleAlert
              size={14}
              className="row-issue"
              aria-label="需留意"
            />
          )}
        </>
      )}
    </button>
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
  onUninstall,
  onUpdated,
  onClose,
}: {
  item: Installation;
  apiScope: string;
  home: string;
  onUninstall: () => void;
  onUpdated: (item: Installation) => void;
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
  const [opening, setOpening] = useState(false);
  const [actionError, setActionError] = useState("");
  async function openLocation(location?: number) {
    setOpening(true);
    setActionError("");
    try {
      await api(
        `/skills/${item.id}/open?scope=${encodeURIComponent(apiScope)}`,
        { method: "POST", body: JSON.stringify({ location }) },
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "无法打开目录。");
    } finally {
      setOpening(false);
    }
  }
  const [sourceDialog, setSourceDialog] = useState(false);
  const [checkingItem, setCheckingItem] = useState(false);
  const p = item.provenance;
  const t = item.tracking;
  async function checkItem() {
    setCheckingItem(true);
    setActionError("");
    try {
      onUpdated(
        await api<Installation>(
          `/skills/${item.id}/check?scope=${encodeURIComponent(apiScope)}`,
          { method: "POST" },
        ),
      );
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setCheckingItem(false);
    }
  }
  return (
    <>
      <div className="detail-heading">
        <div
          className="detail-title"
          style={{ "--hue": hue(item.name) } as CSSProperties}
        >
          <span className="skill-icon" aria-hidden="true">
            {monogram(item.name)}
          </span>
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
        <div className="detail-actions">
          <button
            className="secondary-button"
            onClick={() => void openLocation()}
            disabled={opening}
          >
            {opening ? (
              <Loader2 size={14} className="spinning" />
            ) : (
              <FolderOpen size={14} />
            )}
            打开目录
          </button>
          <button
            className="secondary-button danger-outline"
            onClick={onUninstall}
            disabled={
              item.manager === "external" &&
              item.locations.every((l) => l.kind === "directory")
            }
            title={
              item.manager === "external"
                ? "外部托管的源内容请使用原工具卸载"
                : "选择要移除的安装位置"
            }
          >
            <Trash2 size={14} />
            卸载
          </button>
        </div>
        {actionError && (
          <div className="notice error-notice" role="alert">
            {actionError}
          </div>
        )}
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
            {item.locations.map((location, index) => (
              <div className="location-card" key={location.path}>
                <div className="location-label">
                  <span>
                    {location.kind === "symlink" ? (
                      <Link2 size={13} />
                    ) : (
                      <Folder size={13} />
                    )}
                    <ToolLogo tool={location.tool} />
                    <span className="sr-only">{TOOLS[location.tool]}</span>
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
                  <button
                    className="icon-button"
                    aria-label={`打开安装目录 ${index + 1}`}
                    title="打开此安装目录"
                    disabled={opening}
                    onClick={() => void openLocation(index)}
                  >
                    <FolderOpen size={13} />
                  </button>
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
            <div className="version-actions">
              <UpdateBadge item={item} />
              <button
                className="secondary-button"
                onClick={() => void checkItem()}
                disabled={checkingItem || !(p || t)}
              >
                <RefreshCw
                  size={13}
                  className={checkingItem ? "spinning" : ""}
                />
                {checkingItem ? "检查中…" : "检查此 Skill"}
              </button>
              {!p && (
                <button
                  className="secondary-button"
                  onClick={() => setSourceDialog(true)}
                >
                  <Link2 size={13} />
                  {t ? "编辑来源" : "补录来源"}
                </button>
              )}
            </div>
            <dl className="metadata-list">
              <dt>来源</dt>
              <dd>{p?.source ?? t?.source ?? "未登记来源"}</dd>
              {(p?.sourceUrl || t?.sourceUrl) && (
                <>
                  <dt>来源地址</dt>
                  <dd>
                    <code>{p?.sourceUrl ?? t?.sourceUrl}</code>
                  </dd>
                </>
              )}
              <dt>声明版本</dt>
              <dd>
                {item.declaredVersion ?? "未声明"}
                <span className="field-note">作者元数据，不代表已核验版本</span>
              </dd>
              <dt>跟踪目标</dt>
              <dd>{p?.ref ?? t?.ref ?? "默认分支 / 当前本地来源"}</dd>
              <dt>{p ? "安装记录提交" : "关联时核验提交"}</dt>
              <dd>
                <code>{p?.commit ?? t?.baseline?.commit ?? "未记录"}</code>
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
              {(p?.skillPath || t?.skillPath) && (
                <>
                  <dt>来源目录</dt>
                  <dd>
                    <code>{p?.skillPath ?? t?.skillPath}</code>
                  </dd>
                </>
              )}
              <dt>更新检查</dt>
              <dd>
                <UpdateBadge item={item} />
                <span className="field-note">
                  {item.update?.message ?? "尚未请求上游"}
                </span>
              </dd>
              <dt>本地内容核验</dt>
              <dd>
                {item.update?.localState === "clean"
                  ? "内容已核验一致"
                  : item.update?.localState === "modified"
                    ? "本地已修改"
                    : "尚无可信核验结果"}
              </dd>
              {item.update?.checkedAt && (
                <>
                  <dt>检查时间</dt>
                  <dd>
                    {new Date(item.update.checkedAt).toLocaleString("zh-CN")}
                  </dd>
                </>
              )}
              {item.update?.upstreamCommit && (
                <>
                  <dt>上游提交</dt>
                  <dd>
                    <code>{item.update.upstreamCommit}</code>
                  </dd>
                </>
              )}
              {item.update?.upstreamVersion && (
                <>
                  <dt>上游声明版本</dt>
                  <dd>{item.update.upstreamVersion}</dd>
                </>
              )}
              {t && (
                <>
                  <dt>手动来源基线</dt>
                  <dd>
                    {t.baseline
                      ? "关联时内容核验一致"
                      : "历史版本未知，关联时内容不同"}
                  </dd>
                </>
              )}
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
      {sourceDialog && (
        <SourceDialog
          item={item}
          scope={apiScope}
          onClose={() => setSourceDialog(false)}
          onSaved={(updated) => {
            onUpdated(updated);
            setSourceDialog(false);
          }}
        />
      )}
      <div className="detail-footer">
        <ShieldCheck size={12} /> 读取现有文件，未改动安装内容
      </div>
    </>
  );
}

function AddProject({
  home,
  paths,
  note,
  pending,
  error,
  onClose,
  onPaths,
  onSubmit,
  onPick,
}: {
  home: string;
  paths: string;
  note?: string;
  pending: boolean;
  error: string;
  onClose: () => void;
  onPaths: (paths: string) => void;
  onSubmit: (paths: string[]) => void;
  onPick?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="add-project-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onClose();
      }}
      onClick={(event) => {
        if (!pending && event.target === dialog.current) onClose();
      }}
      className="project-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const inputs = paths
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (inputs.length) onSubmit(inputs);
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
            disabled={pending}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <h2 id="add-project-title">添加项目</h2>
        {note && <p>{note}</p>}
        {onPick && (
          <button
            type="button"
            className="secondary-button project-folder-picker"
            onClick={onPick}
            disabled={pending}
          >
            <FolderOpen size={15} /> 选取文件夹
          </button>
        )}
        <label htmlFor="project-path">项目目录</label>
        <textarea
          autoFocus
          id="project-path"
          rows={3}
          placeholder={`${home || "~"}/Code/my-project`}
          value={paths}
          onChange={(e) => onPaths(e.target.value)}
          disabled={pending}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="project-path-note"
        />
        <span className="input-note" id="project-path-note">
          每行一个绝对路径或 ~/ 路径
        </span>
        {error && (
          <div className="notice error-notice" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={pending}
          >
            取消
          </button>
          <button
            className="primary-button"
            disabled={pending || !paths.trim()}
          >
            {pending ? (
              <Loader2 size={14} className="spinning" />
            ) : (
              <Plus size={14} />
            )}
            {pending ? "处理中…" : "添加项目"}
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
