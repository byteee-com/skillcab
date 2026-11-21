import { spawn } from "node:child_process";

export function openDirectory(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const command =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer.exe"
          : "xdg-open";
    const child = spawn(command, [path], { stdio: "ignore", shell: false });
    child.once("error", () =>
      reject(new Error("无法启动文件管理器，请复制目录路径后打开。")),
    );
    if (process.platform === "win32") child.once("spawn", resolve);
    else {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("文件管理器启动超时，请复制目录路径后打开。"));
      }, 10000);
      child.once("error", () => clearTimeout(timeout));
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error("文件管理器未能打开目录，请复制路径后重试。"));
      });
    }
  });
}
