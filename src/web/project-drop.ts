export function droppedProjectPaths(transfer: DataTransfer): string[] {
  const urls = transfer.getData("text/uri-list");
  const lines = (urls || transfer.getData("text/plain"))
    .split(/\r?\n/)
    .filter((line) => line && !(urls && line.startsWith("#")));
  const paths: string[] = [];
  for (const line of lines) {
    if (line.startsWith("file:")) {
      try {
        const url = new URL(line);
        if (url.host || url.search || url.hash) return [];
        const path = decodeURIComponent(url.pathname);
        paths.push(path.replace(/^\/(?=[A-Za-z]:\/)/, ""));
      } catch {
        return [];
      }
    } else if (/^(?:\/|[A-Za-z]:[\\/]|\\\\|~\/)/.test(line)) {
      paths.push(line);
    } else {
      return [];
    }
  }
  return paths;
}

export function droppedFolderNames(transfer: DataTransfer): string[] {
  const names: string[] = [];
  for (const item of transfer.items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (!entry?.isDirectory) return [];
    names.push(entry.name);
  }
  return names;
}
