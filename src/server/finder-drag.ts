import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface FinderDrag {
  changeCount: string;
  paths?: string[];
}

const run = promisify(execFile);
const script = `
ObjC.import("AppKit");
function run(argv) {
  const board = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag);
  const changeCount = String(board.changeCount);
  if (argv[0] === "count") return JSON.stringify({ changeCount });
  const types = ObjC.deepUnwrap(board.types) || [];
  if (!types.includes("com.apple.finder.node")) return JSON.stringify({ changeCount });
  const paths = ObjC.deepUnwrap(board.propertyListForType("NSFilenamesPboardType"));
  if (changeCount !== String(board.changeCount)) return "{}";
  return JSON.stringify({ changeCount, paths });
}`;

export async function readFinderDrag(paths: boolean): Promise<FinderDrag> {
  const { stdout } = await run(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", script, paths ? "paths" : "count"],
    { encoding: "utf8", timeout: 4000, maxBuffer: 512 * 1024 },
  );
  return JSON.parse(stdout) as FinderDrag;
}
