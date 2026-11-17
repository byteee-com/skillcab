export type ToolId = "shared" | "codex" | "claude-code" | "cursor" | "custom";
export type Manager = "skills-cli" | "local" | "external";
export interface Diagnostic {
  code: string;
  message: string;
  path?: string;
}
export interface Scope {
  id: string;
  kind: "global" | "project";
  name: string;
  path: string;
}
export interface ScanRoot {
  path: string;
  tool: ToolId;
}
export interface RootResult extends ScanRoot {
  state: "present" | "missing" | "error";
}
export interface Location {
  path: string;
  rootPath: string;
  tool: ToolId;
  kind: "directory" | "symlink" | "broken";
  linkTarget?: string;
}
export interface Provenance {
  recordPath: string;
  recordKey: string;
  schema: number;
  source: string;
  sourceType?: string;
  sourceUrl?: string;
  skillPath?: string;
  originalName?: string;
  ref?: string;
  commit?: string;
  installedAt?: string;
  updatedAt?: string;
  hash?: { algorithm: string; value: string };
  record: Record<string, unknown>;
}
export interface Installation {
  id: string;
  scope: Scope;
  name: string;
  directoryName: string;
  description: string;
  author?: string;
  declaredVersion?: string;
  realPath?: string;
  locations: Location[];
  manager: Manager;
  provenance?: Provenance;
  diagnostics: Diagnostic[];
  documentState: "valid" | "invalid" | "missing" | "unreadable";
}
export interface Inventory {
  scope: Scope;
  roots: RootResult[];
  installations: Installation[];
  diagnostics: Diagnostic[];
  scannedAt: string;
  truncated: boolean;
}
export interface ResourceFile {
  path: string;
  kind: "file" | "symlink";
  size?: number;
}
export interface SkillDetail {
  installation: Installation;
  markdown: string;
  raw: string;
  metadata: Record<string, unknown>;
  files: ResourceFile[];
  truncated: boolean;
  diagnostics: Diagnostic[];
}
export interface ScanOptions {
  home?: string;
  project?: string;
  codexHome?: string;
  xdgStateHome?: string;
  additionalRoots?: ScanRoot[];
  maxEntries?: number;
}
export interface Project {
  id: string;
  name: string;
  path: string;
}
export interface AppState {
  version: string;
  home: string;
  projects: Project[];
  configIssue?: string;
}
