import { useEffect, useRef, useState } from "react";
import { Link2, Loader2, X } from "lucide-react";
import { api } from "./api.js";
import type { Installation, UpdateCheck } from "../core/types.js";
export const UPDATE_LABELS: Record<UpdateCheck["status"], string> = {
  available: "有更新",
  current: "已是最新",
  unknown: "版本未知",
  error: "检查失败",
  untracked: "未关联来源",
  unchecked: "未检查",
  unsupported: "暂不支持",
};
export function UpdateBadge({ item }: { item: Installation }) {
  const status =
    item.update?.status ??
    (item.provenance || item.tracking ? "unchecked" : "untracked");
  return (
    <span
      className={`update-badge update-${status}`}
      title={item.update?.message}
    >
      {UPDATE_LABELS[status]}
      {item.update?.localState === "modified" && " · 本地已修改"}
    </span>
  );
}
export function versionLabel(item: Installation) {
  const commit = item.provenance?.commit ?? item.tracking?.baseline?.commit;
  if (item.declaredVersion) return `v${item.declaredVersion.replace(/^v/, "")}`;
  if (commit) return commit.slice(0, 8);
  const fingerprint =
    item.provenance?.hash?.value ?? item.tracking?.baseline?.hash;
  return fingerprint && /^[a-f0-9]{40,64}$/i.test(fingerprint)
    ? `${item.provenance?.hash?.algorithm === "git-tree" ? "tree" : "hash"}:${fingerprint.slice(0, 8)}`
    : "版本未知";
}

export function SourceDialog({
  item,
  scope,
  onClose,
  onSaved,
}: {
  item: Installation;
  scope: string;
  onClose: () => void;
  onSaved: (item: Installation) => void;
}) {
  const [source, setSource] = useState(item.tracking?.sourceUrl ?? "");
  const [ref, setRef] = useState(item.tracking?.ref ?? "");
  const [path, setPath] = useState(item.tracking?.skillPath ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const endpoint = `/skills/${item.id}/source?scope=${encodeURIComponent(scope)}`;
  async function save(remove = false) {
    setBusy(true);
    setError("");
    try {
      const updated = await api<Installation>(endpoint, {
        method: remove ? "DELETE" : "PUT",
        ...(remove
          ? {}
          : {
              body: JSON.stringify({
                source,
                ref: ref.trim() || undefined,
                skillPath: path.trim() || undefined,
              }),
            }),
      });
      onSaved(updated);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="project-dialog operation-dialog source-dialog"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="dialog-top">
          <span className="detail-symbol">
            <Link2 size={23} />
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭来源登记"
            onClick={onClose}
            disabled={busy}
          >
            <X size={17} />
          </button>
        </div>
        <h2>{item.tracking ? "编辑来源" : "补录来源"}</h2>
        <p>
          为 {item.name} 登记 Git 仓库或本地来源。保存前核验内容；不会修改 Skill
          文件和 CLI 锁文件。
        </p>
        <label htmlFor="tracking-source">来源地址</label>
        <input
          id="tracking-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="owner/repo、Git URL 或本地目录"
          required
          autoFocus
          disabled={busy}
        />
        <label htmlFor="tracking-ref">分支、标签或提交（可选）</label>
        <input
          id="tracking-ref"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="留空跟踪默认分支"
          disabled={busy}
        />
        <label htmlFor="tracking-path">仓库内目录（可选）</label>
        <input
          id="tracking-path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="按 Skill 名称匹配；根目录填 ."
          disabled={busy}
        />
        <p className="input-note">
          只有内容一致才建立可信基线。不一致时保留来源，版本显示未知。标签和提交按固定目标检查。
        </p>
        {error && (
          <div className="notice error-notice" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          {item.tracking && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void save(true)}
            >
              移除关联
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </button>
          <button className="primary-button" disabled={busy}>
            {busy && <Loader2 size={14} className="spinning" />}
            {busy ? "正在核验…" : "核验并保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
