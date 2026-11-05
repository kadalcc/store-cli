import { spawn } from "node:child_process";

/** Best effort: if no browser opens (SSH, a container, CI), the URL is already on screen. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // `start` treats its first quoted argument as a window title, hence the empty one.
          ["cmd", ["/c", "start", "", url.replace(/&/g, "^&")]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args as string[], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* the URL is printed */
  }
}
