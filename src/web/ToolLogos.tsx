import { Folder, Layers3 } from "lucide-react";
import claude from "./assets/claude.svg";
import codex from "./assets/codex.svg";
import cursor from "./assets/cursor.svg";
import type { ToolId } from "../core/types.js";
export const TOOL_NAMES: Record<ToolId, string> = {
  shared: "共享目录",
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  custom: "自定义",
};
const logos: Partial<Record<ToolId, string>> = {
  codex,
  "claude-code": claude,
  cursor,
};
export function ToolLogo({ tool }: { tool: ToolId }) {
  return (
    <span
      className={`tool-logo tool-${tool}`}
      title={TOOL_NAMES[tool]}
      role="img"
      aria-label={TOOL_NAMES[tool]}
    >
      {logos[tool] ? (
        <img src={logos[tool]} alt="" aria-hidden="true" />
      ) : tool === "shared" ? (
        <Layers3 size={15} aria-hidden="true" />
      ) : (
        <Folder size={15} aria-hidden="true" />
      )}
    </span>
  );
}
