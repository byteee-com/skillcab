import { execFile } from "node:child_process";
import { promisify } from "node:util";

const chooseFolders = `
const app = Application.currentApplication();
app.includeStandardAdditions = true;
try {
  app.activate();
  JSON.stringify(app.chooseFolder({
    withPrompt: "选择要添加到 skillcab 的项目文件夹",
    multipleSelectionsAllowed: true
  }).map(folder => folder.toString()));
} catch (error) {
  if (error.errorNumber !== -128) throw error;
  "[]";
}`;

export async function pickProjectFolders(): Promise<string[]> {
  try {
    const { stdout } = await promisify(execFile)(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", chooseFolders],
      { encoding: "utf8", timeout: 180000, maxBuffer: 512 * 1024 },
    );
    return JSON.parse(stdout) as string[];
  } catch {
    throw new Error("无法使用系统文件夹窗口，请粘贴项目路径后重试。");
  }
}
