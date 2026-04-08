import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { ActivityType, Client } from "./rpc/client";
import { getAsset } from "./assets";
import { log } from "./logger";

interface Activity {
  state?: string;
  details?: string;
  timestamps?: {
    start?: number | Date;
    end?: number | Date;
  };
  assets?: {
    large_image?: string;
    large_text?: string;
    small_image?: string;
    small_text?: string;
  };
  buttons?: { label: string; url: string }[];
  type?: ActivityType.Playing | ActivityType.Listening | ActivityType.Watching | ActivityType.Competing;
}

const getConfig = () => vscode.workspace.getConfiguration("vscodeRpc");

const getGitInfo = (): { url?: string; name?: string } => {
  try {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (!workspaceRoot) {
      log.info("getGitInfo: no workspace folder");
      return {};
    }
    const gitConfigPath = path.join(workspaceRoot, ".git", "config");
    const gitConfig = fs.readFileSync(gitConfigPath, "utf8");
    const match = gitConfig.match(/\[remote "origin"\][^\[]*url\s*=\s*(.+)/);
    if (!match) {
      log.info("getGitInfo: no origin remote found in", gitConfigPath);
      return {};
    }
    const fetchUrl = match[1].trim();
    const url = fetchUrl
      .replace(/^git@([^:]+):(.+?)(?:\.git)?$/, "https://$1/$2")
      .replace(/\.git$/, "");
    const name = url.split("/").slice(-2).join("/");
    log.info("getGitInfo: url =", url, "name =", name);
    return { url, name };
  } catch (e) {
    log.info("getGitInfo: error", String(e));
    return {};
  }
};

const buildSmallText = (isCoding: boolean): string | undefined => {
  const config = getConfig();
  if (!config.get<boolean>("showActivityStatus", true)) return undefined;
  return isCoding ? "Coding" : "Idle";
};

const buildButtons = (): { label: string; url: string }[] | undefined => {
  const config = getConfig();
  if (!config.get<boolean>("showRepositoryButton", true)) return undefined;
  const { url } = getGitInfo();
  if (!url) return undefined;
  return [{ label: "View Repository", url }];
};

const throttleTime = 10000; // 10 seconds
let lastActivityChangeTime = 0;
let setActivityTimer: NodeJS.Timeout;
const throttledSetActivity = () => {
  const now = Date.now();
  if (now - lastActivityChangeTime < throttleTime) {
    clearTimeout(setActivityTimer);
    setActivityTimer = setTimeout(throttledSetActivity, throttleTime + 250 - (now - lastActivityChangeTime));
    return;
  }
  lastActivityChangeTime = now;
  client.setActivity(activityData);
};

const setIdle = () => {
  const config = getConfig();
  const showActivityStatus = config.get<boolean>("showActivityStatus", true);
  Object.assign(activityData, {
    details: showActivityStatus ? "Not in a file!" : undefined,
    state: undefined,
    buttons: buildButtons(),
    assets: {
      large_image: getAsset({ name: "vscode" }),
      small_text: buildSmallText(false),
    },
  });
  throttledSetActivity();
};

const setFile = (filePath: string, fileName: string, line: number, col: number) => {
  Object.assign(activityData, {
    details: `${fileName}:${line}:${col}`,
    state: undefined,
    buttons: buildButtons(),
    assets: {
      large_image: getAsset({ fileName, filePath }),
      small_image: getAsset({ name: "vscode" }),
      small_text: buildSmallText(true),
    },
  });
  throttledSetActivity();
};

const setNotebook = (cell: number, totalCells: number) => {
  Object.assign(activityData, {
    details: `Cell ${cell} of ${totalCells}`,
    state: undefined,
    buttons: buildButtons(),
    assets: {
      large_image: getAsset({ name: "python" }),
      small_image: getAsset({ name: "vscode" }),
      small_text: buildSmallText(true),
    },
  });
  throttledSetActivity();
};

export const client = new Client({
  clientId: "1442327910529761351",
});
const activityData: Activity = {
  timestamps: {
    start: Date.now(),
  },
  type: ActivityType.Playing,
};

const updateActivity = () => {
  const t = vscode.window.activeTextEditor;
  if (t && t.document && t.selection && t.document.uri.scheme !== "vscode-notebook-cell") {
    return setFile(
      t.document.fileName.replaceAll("\\", "/") || "Untitled",
      t.document.fileName.split("/").pop()?.split("\\").pop() || "Untitled",
      t.selection.start.line + 1,
      t.selection.start.character + 1
    );
  }
  const n = vscode.window.activeNotebookEditor;
  if (n && n.notebook && n.selection) {
    return setNotebook(n.selection.start + 1, n.notebook.cellCount);
  }
  return setIdle();
};

let reconnectInterval: NodeJS.Timeout;
const reconnectFreq = 10000;
const reconnect = async () => {
  log.info("Reconnecting...");
  try {
    await client.login();
  } catch {}
};
client.on("ready", () => {
  try {
    clearInterval(reconnectInterval);
  } catch {}
  log.info("Connected");
  updateActivity();
});
client.on("close", () => {
  reconnectInterval = setInterval(reconnect, reconnectFreq);
});
(async () => {
  try {
    await client.login();
  } catch {
    reconnectInterval = setInterval(reconnect, reconnectFreq);
  }
})();

vscode.window.onDidChangeActiveTextEditor(updateActivity);
vscode.window.onDidChangeTextEditorSelection(updateActivity);

vscode.window.onDidChangeActiveNotebookEditor(updateActivity);
vscode.window.onDidChangeNotebookEditorSelection(updateActivity);

// Re-apply activity when config changes
vscode.workspace.onDidChangeConfiguration((e) => {
  if (e.affectsConfiguration("vscodeRpc")) {
    updateActivity();
  }
});
