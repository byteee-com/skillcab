import { useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2, Plus, Trash2, X } from "lucide-react";
import { api } from "./api.js";
import type { Installation, Project } from "../core/types.js";
import type {
  InstallTool,
  OperationPreview,
  OperationResult,
  SourceCatalog,
} from "../core/operations.js";

function Preview({ value }: { value: OperationPreview }) {
  return (
    <div className="operation-preview">
      <div className="operation-scope">
        {value.scopeName}{" "}
        <span>
          {value.type === "install" ? "安装" : "卸载"} {value.name}
        </span>
      </div>
      {value.source && (
        <div className="operation-source">
          <span>来源</span>
          <code>{value.source}</code>
          {value.ref && (
            <span>
              跟踪目标 <code>{value.ref}</code>
            </span>
          )}
          {value.commit && (
            <span title={value.commit}>
              安装提交 <code>{value.commit.slice(0, 12)}</code>
            </span>
          )}
        </div>
      )}
      <ul className="operation-paths">
        {value.paths.map((entry) => (
          <li key={entry.path}>
            <span>{entry.action}</span>
            <code>{entry.path}</code>
          </li>
        ))}
      </ul>
      <ul className="operation-notes">
        {value.notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}

export function InstallDialog({
  scopeId,
  projects,
  onClose,
  onApplied,
}: {
  scopeId: string;
  projects: Project[];
  onClose: () => void;
  onApplied: (result: OperationResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const sourceId = useRef<string | undefined>(undefined);
  const previewId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const [source, setSource] = useState("");
  const [ref, setRef] = useState("");
  const [scope, setScope] = useState(scopeId);
  const [catalog, setCatalog] = useState<SourceCatalog>();
  const [name, setName] = useState("");
  const [tools, setTools] = useState<InstallTool[]>(["codex"]);
  const [preview, setPreview] = useState<OperationPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      if (sourceId.current)
        void api(`/install/sources/${sourceId.current}`, {
          method: "DELETE",
        }).catch(() => undefined);
      if (previewId.current)
        void api(`/operations/${previewId.current}`, {
          method: "DELETE",
        }).catch(() => undefined);
    };
  }, []);
  async function resolveSource() {
    setBusy(true);
    setError("");
    try {
      const value = await api<SourceCatalog>("/install/sources", {
        method: "POST",
        body: JSON.stringify({ source, ref: ref || undefined, scope }),
      });
      if (!mounted.current) {
        void api(`/install/sources/${value.id}`, { method: "DELETE" }).catch(
          () => undefined,
        );
        return;
      }
      sourceId.current = value.id;
      setCatalog(value);
      setName(value.skills[0]?.name ?? "");
    } catch (error) {
      setError(error instanceof Error ? error.message : "来源读取失败。");
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (preview)
        onApplied(
          await api<OperationResult>(`/operations/${preview.id}/apply`, {
            method: "POST",
          }),
        );
      else
        setPreview(
          await api<OperationPreview>("/operations/install/preview", {
            method: "POST",
            body: JSON.stringify({ catalogId: catalog?.id, name, tools }),
          }),
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : "安装失败。");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (preview) previewId.current = preview.id;
  }, [preview]);
  return (
    <dialog
      ref={dialog}
      className="project-dialog operation-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy || !preview) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (catalog) void submit();
          else void resolveSource();
        }}
      >
        <div className="dialog-top">
          <span className="detail-symbol">
            <Plus size={23} />
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭安装"
            disabled={busy && !!preview}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <h2>{preview ? "确认安装" : "安装 Skill"}</h2>
        <p>从 Git 仓库或本地目录选择内容，安装到全局或项目。</p>
        {preview ? (
          <Preview value={preview} />
        ) : (
          <>
            <label htmlFor="install-scope">安装范围</label>
            <select
              id="install-scope"
              value={scope}
              disabled={busy || !!catalog}
              onChange={(event) => setScope(event.target.value)}
            >
              <option value="global">全局 Skills</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <label htmlFor="install-source">来源</label>
            <input
              autoFocus
              id="install-source"
              value={source}
              disabled={busy || !!catalog}
              required
              placeholder="owner/repo、Git URL 或 /本地/Skill目录"
              onChange={(event) => setSource(event.target.value)}
            />
            <label htmlFor="install-ref">
              分支、标签或提交 <span className="muted">（可选）</span>
            </label>
            <input
              id="install-ref"
              value={ref}
              disabled={busy || !!catalog}
              placeholder="默认使用仓库的默认分支"
              onChange={(event) => setRef(event.target.value)}
            />
            {catalog && (
              <>
                <button
                  className="text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void api(`/install/sources/${catalog.id}`, {
                      method: "DELETE",
                    });
                    sourceId.current = undefined;
                    setCatalog(undefined);
                  }}
                >
                  更改来源
                </button>
                <label htmlFor="install-skill">
                  选择 Skill（{catalog.skills.length}）
                </label>
                <select
                  id="install-skill"
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                >
                  {catalog.skills.map((skill, i) => (
                    <option key={`${skill.name}-${i}`} value={skill.name}>
                      {skill.name}
                    </option>
                  ))}
                </select>
                <p className="candidate-description">
                  {
                    catalog.skills.find((skill) => skill.name === name)
                      ?.description
                  }
                </p>
                <fieldset className="tool-picker">
                  <legend>目标工具</legend>
                  {(
                    [
                      ["codex", "Codex"],
                      ["claude-code", "Claude Code"],
                      ["cursor", "Cursor"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={tools.includes(key)}
                        disabled={busy}
                        onChange={(event) =>
                          setTools((current) =>
                            event.target.checked
                              ? [...current, key]
                              : current.filter((tool) => tool !== key),
                          )
                        }
                      />
                      {label}
                    </label>
                  ))}
                </fieldset>
              </>
            )}
          </>
        )}
        {error && (
          <div className="notice error-notice" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              if (preview) {
                void api(`/operations/${preview.id}`, {
                  method: "DELETE",
                }).catch(() => undefined);
                setPreview(undefined);
                previewId.current = undefined;
              } else onClose();
            }}
          >
            {preview ? "返回选择" : "取消"}
          </button>
          <button
            className="primary-button"
            disabled={busy || !source.trim() || (!!catalog && !tools.length)}
          >
            {busy ? (
              <Loader2 size={14} className="spinning" />
            ) : (
              <Plus size={14} />
            )}
            {busy
              ? "处理中…"
              : preview
                ? "确认安装"
                : catalog
                  ? "预览安装"
                  : "读取来源"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function UninstallDialog({
  item,
  scopeId,
  onClose,
  onApplied,
}: {
  item: Installation;
  scopeId: string;
  onClose: () => void;
  onApplied: (result: OperationResult) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const previewId = useRef<string | undefined>(undefined);
  const [locations, setLocations] = useState(item.locations.map((_, i) => i));
  const [preview, setPreview] = useState<OperationPreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      if (previewId.current)
        void api(`/operations/${previewId.current}`, {
          method: "DELETE",
        }).catch(() => undefined);
    };
  }, []);
  useEffect(() => {
    if (preview) previewId.current = preview.id;
  }, [preview]);
  async function submit() {
    setBusy(true);
    setError("");
    try {
      if (preview)
        onApplied(
          await api<OperationResult>(`/operations/${preview.id}/apply`, {
            method: "POST",
          }),
        );
      else
        setPreview(
          await api<OperationPreview>("/operations/uninstall/preview", {
            method: "POST",
            body: JSON.stringify({ id: item.id, scope: scopeId, locations }),
          }),
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : "卸载失败。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="project-dialog operation-dialog"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy || !preview) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-top">
          <span className="detail-symbol">
            <Trash2 size={23} />
          </span>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭卸载"
            disabled={busy && !!preview}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <h2>{preview ? "确认卸载" : "卸载 Skill"}</h2>
        <p>
          {item.name} · {item.scope.name}
        </p>
        {preview ? (
          <Preview value={preview} />
        ) : (
          <>
            <div className="operation-notes">
              选择要移除的安装位置。链接指向的源目录会保留；移除内容目录时，会检查已登记范围中的其他关联。
            </div>
            <div className="uninstall-locations">
              {item.locations.map((location, index) => (
                <label key={location.path}>
                  <input
                    type="checkbox"
                    checked={locations.includes(index)}
                    onChange={(event) =>
                      setLocations((current) =>
                        event.target.checked
                          ? [...current, index]
                          : current.filter((i) => i !== index),
                      )
                    }
                  />
                  <span>
                    <code>{location.path}</code>
                    <small>
                      {location.kind === "directory"
                        ? "内容目录"
                        : "链接入口（保留源目录）"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        {error && (
          <div className="notice error-notice" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              if (preview) {
                void api(`/operations/${preview.id}`, {
                  method: "DELETE",
                }).catch(() => undefined);
                setPreview(undefined);
                previewId.current = undefined;
              } else onClose();
            }}
          >
            {preview ? "返回选择" : "取消"}
          </button>
          <button
            className="primary-button danger-button"
            disabled={busy || !locations.length}
          >
            {busy ? (
              <Loader2 size={14} className="spinning" />
            ) : (
              <Trash2 size={14} />
            )}
            {busy ? "处理中…" : preview ? "确认卸载" : "预览卸载"}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function OperationNotice({
  result,
  onUndo,
  onDismiss,
}: {
  result: OperationResult;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="operation-notice" role="status">
      <div>
        <strong>
          已{result.type === "install" ? "安装" : "卸载"} {result.name}
        </strong>
        {(result.type === "uninstall" || result.warning) && (
          <details>
            <summary>
              <FolderOpen size={12} />
              备份位置
            </summary>
            <code>{result.backupPath}</code>
          </details>
        )}
        {result.warning && <p role="alert">{result.warning}</p>}
        {error && <p role="alert">{error}</p>}
      </div>
      {result.undoAvailable && (
        <button
          className="secondary-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/operations/${result.id}/undo`, { method: "POST" });
              onUndo();
            } catch (error) {
              setError(error instanceof Error ? error.message : "恢复失败。");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "恢复中…" : "撤销卸载"}
        </button>
      )}
      <button
        className="icon-button"
        aria-label="关闭操作提示"
        onClick={onDismiss}
      >
        <X size={15} />
      </button>
    </div>
  );
}
