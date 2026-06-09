import { spawnSync } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_FILE, SHIM_DIR } from "./paths.ts";

/**
 * Windows scheduled-task integration: run `shim serve` at logon in the
 * background. The TUI (`shim`) attaches separately and controls the running
 * service through the shared sqlite store.
 *
 * The task launches a hidden `.vbs` → `runner.cmd` chain rather than bun
 * directly, which: (1) `cd`s to the project root so Bun can load `.env`
 * (scheduled tasks start from System32), (2) redirects output to LOG_FILE, and
 * (3) runs with no visible console window.
 */

const TASK_NAME = "ShimCliProxy";
const RUNNER_CMD = join(SHIM_DIR, "runner.cmd");
const LAUNCHER_VBS = join(SHIM_DIR, "launcher.vbs");

export async function installService(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("service install is Windows-only");
  }
  await mkdir(SHIM_DIR, { recursive: true });

  const bunPath = process.execPath;
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  // Scheduled tasks start from System32; run from the project root so Bun loads `.env`.
  const projectRoot = resolve(dirname(entry), "..");

  const runnerContent =
    `@echo off\r\n` +
    `cd /D "${projectRoot}"\r\n` +
    `"${bunPath}" run "${entry}" serve >> "${LOG_FILE}" 2>&1\r\n`;
  await writeFile(RUNNER_CMD, runnerContent, "utf8");

  const vbsContent =
    `Set WshShell = CreateObject("WScript.Shell")\r\n` +
    `WshShell.Run """${RUNNER_CMD}""", 0, False\r\n`;
  await writeFile(LAUNCHER_VBS, vbsContent, "utf8");

  const taskAction = `wscript.exe "${LAUNCHER_VBS}"`;
  const create = spawnSync(
    "schtasks",
    ["/Create", "/TN", TASK_NAME, "/TR", taskAction, "/SC", "ONLOGON", "/F"],
    { encoding: "utf8" },
  );
  if (create.status !== 0) {
    throw new Error(formatSchtasksError("/Create", create.stderr || create.stdout));
  }

  const run = spawnSync("schtasks", ["/Run", "/TN", TASK_NAME], { encoding: "utf8" });
  console.log(
    `[shim] scheduled task "${TASK_NAME}" installed (auto-start at logon). Logs: ${LOG_FILE}`,
  );
  if (run.status === 0) {
    console.log("[shim] service started now (running in the background).");
  } else {
    console.log(
      `[shim] task created but failed to start now: ${trimOutput(run.stderr || run.stdout || "unknown error")}`,
    );
    console.log(`[shim] it will start on next logon, or run: schtasks /Run /TN ${TASK_NAME}`);
  }
}

export async function uninstallService(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("service uninstall is Windows-only");
  }
  spawnSync("schtasks", ["/End", "/TN", TASK_NAME], { encoding: "utf8" });
  const del = spawnSync("schtasks", ["/Delete", "/TN", TASK_NAME, "/F"], { encoding: "utf8" });
  if (del.status !== 0) {
    const out = (del.stderr || del.stdout || "").toLowerCase();
    const notFound =
      out.includes("does not exist") ||
      out.includes("cannot find") ||
      out.includes("the system cannot find");
    if (!notFound) {
      throw new Error(formatSchtasksError("/Delete", del.stderr || del.stdout));
    }
  }
  await safeUnlink(LAUNCHER_VBS);
  await safeUnlink(RUNNER_CMD);
  console.log(`[shim] scheduled task "${TASK_NAME}" removed.`);
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function trimOutput(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function formatSchtasksError(op: string, raw: string): string {
  const trimmed = trimOutput(raw);
  const lower = trimmed.toLowerCase();
  const denied =
    lower.includes("access is denied") ||
    lower.includes("access denied") ||
    trimmed.includes("Accès refusé") ||
    trimmed.includes("acces refuse");
  if (denied) {
    return `schtasks ${op} refused (Access denied). Re-run this command in a PowerShell launched as Administrator.`;
  }
  return `schtasks ${op} failed: ${trimmed}`;
}
