import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { selfCommand } from "./mcp/self-command.js";

export type LibraryKeepalivePlatform = "darwin" | "linux" | "win32";

export interface LibraryKeepaliveOptions {
  homeDir?: string;
  platform?: LibraryKeepalivePlatform;
  intervalMinutes?: number;
  executable?: string;
  executableArgs?: string[];
  uid?: number;
  runCommand?: typeof spawnSync;
}

export interface LibraryKeepaliveFile {
  path: string;
  content: string;
  encoding?: "utf8" | "utf16le";
}

export interface LibraryKeepaliveCommand {
  command: string;
  args: string[];
  ignoreFailure?: boolean;
}

export interface LibraryKeepalivePlan {
  platform: LibraryKeepalivePlatform;
  label: string;
  scheduler: string;
  schedule: string;
  path: string;
  logPath: string;
  intervalMinutes: number;
  command: string[];
  files: LibraryKeepaliveFile[];
  installCommands: LibraryKeepaliveCommand[];
  removeCommands: LibraryKeepaliveCommand[];
  cleanupCommands: LibraryKeepaliveCommand[];
}

export interface LibraryKeepaliveResult {
  installed: boolean;
  scheduler: string;
  schedule: string;
  label: string;
  path: string;
  log_path: string;
  interval_minutes: number;
  command: string[];
}

export const LIBRARY_KEEPALIVE_DEFAULT_INTERVAL_MINUTES = 30;

/**
 * Keep the encrypted HKUL cookie active without reopening SSO. The scheduled
 * command only touches an already saved session; it never opens a browser.
 */
export async function installLibraryKeepalive(
  options: LibraryKeepaliveOptions = {},
): Promise<LibraryKeepaliveResult> {
  const plan = buildLibraryKeepalivePlan(options);
  for (const file of plan.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    if (file.encoding === "utf16le") {
      await writeFile(file.path, Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(file.content, "utf16le"),
      ]), { mode: 0o600 });
    } else {
      await writeFile(file.path, file.content, { encoding: "utf8", mode: 0o600 });
    }
  }
  runCommands(plan.installCommands, options.runCommand ?? spawnSync);
  return resultFor(plan);
}

export async function uninstallLibraryKeepalive(
  options: LibraryKeepaliveOptions = {},
): Promise<LibraryKeepaliveResult> {
  const plan = buildLibraryKeepalivePlan(options);
  runCommands(plan.removeCommands, options.runCommand ?? spawnSync);
  for (const file of plan.files) await rm(file.path, { force: true });
  runCommands(plan.cleanupCommands, options.runCommand ?? spawnSync);
  return { ...resultFor(plan), installed: false };
}

export async function libraryKeepaliveStatus(
  options: LibraryKeepaliveOptions = {},
): Promise<LibraryKeepaliveResult> {
  const plan = buildLibraryKeepalivePlan(options);
  let installed = await access(plan.path).then(() => true, () => false);
  if (installed && plan.platform === "win32") {
    const query = (options.runCommand ?? spawnSync)("schtasks.exe", ["/Query", "/TN", plan.label], {
      stdio: "ignore",
    }) as SpawnSyncReturns<Buffer>;
    installed = !query.error && query.status === 0;
  }
  return { ...resultFor(plan), installed };
}

export function buildLibraryKeepalivePlan(options: LibraryKeepaliveOptions = {}): LibraryKeepalivePlan {
  const homeDir = options.homeDir ?? homedir();
  const platform = options.platform ?? normalizePlatform(process.platform);
  const intervalMinutes = options.intervalMinutes ?? LIBRARY_KEEPALIVE_DEFAULT_INTERVAL_MINUTES;
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 24 * 60) {
    throw new Error("HKUL keepalive interval must be an integer from 5 to 1440 minutes.");
  }
  const executable = options.executable
    ?? selfCommand([process.execPath, process.argv[1] ?? ""], process.execPath).command;
  const executableArgs = options.executableArgs
    ?? selfCommand([process.execPath, process.argv[1] ?? ""], process.execPath).args;
  const command = [executable, ...executableArgs, "library", "keepalive", "--json"];
  return platform === "darwin"
    ? macOSPlan(homeDir, command, intervalMinutes, options.uid)
    : platform === "linux"
      ? linuxPlan(homeDir, command, intervalMinutes)
      : windowsPlan(homeDir, command, intervalMinutes);
}

function macOSPlan(
  homeDir: string,
  command: string[],
  intervalMinutes: number,
  uid?: number,
): LibraryKeepalivePlan {
  const label = "com.hku-cli.library-keepalive";
  const path = join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
  const logPath = join(homeDir, "Library", "Logs", `${label}.log`);
  const target = `gui/${uid ?? (typeof process.getuid === "function" ? process.getuid() : 0)}`;
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${xml(label)}</string>`,
    "<key>ProgramArguments</key><array>",
    ...command.map(arg => `<string>${xml(arg)}</string>`),
    "</array>",
    `<key>StartInterval</key><integer>${intervalMinutes * 60}</integer>`,
    "<key>RunAtLoad</key><true/>",
    `<key>StandardOutPath</key><string>${xml(logPath)}</string>`,
    `<key>StandardErrorPath</key><string>${xml(logPath)}</string>`,
    "</dict></plist>",
    "",
  ].join("\n");
  return {
    platform: "darwin",
    label,
    scheduler: "launchd agent",
    schedule: `every ${intervalMinutes} minutes`,
    path,
    logPath,
    intervalMinutes,
    command,
    files: [{ path, content: plist }],
    installCommands: [
      { command: "launchctl", args: ["bootout", `${target}/${label}`], ignoreFailure: true },
      { command: "launchctl", args: ["bootstrap", target, path] },
    ],
    removeCommands: [{ command: "launchctl", args: ["bootout", `${target}/${label}`], ignoreFailure: true }],
    cleanupCommands: [],
  };
}

function linuxPlan(homeDir: string, command: string[], intervalMinutes: number): LibraryKeepalivePlan {
  const label = "hku-cli-library-keepalive";
  const directory = join(homeDir, ".config", "systemd", "user");
  const servicePath = join(directory, `${label}.service`);
  const timerPath = join(directory, `${label}.timer`);
  const service = [
    "[Unit]",
    "Description=HKU CLI HKUL session keepalive",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=${command.map(systemdQuote).join(" ")}`,
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=HKU CLI HKUL session keepalive timer",
    "",
    "[Timer]",
    "OnBootSec=2m",
    `OnUnitActiveSec=${intervalMinutes}m`,
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return {
    platform: "linux",
    label,
    scheduler: "systemd user timer",
    schedule: `every ${intervalMinutes} minutes`,
    path: timerPath,
    logPath: `journalctl --user -u ${label}`,
    intervalMinutes,
    command,
    files: [
      { path: servicePath, content: service },
      { path: timerPath, content: timer },
    ],
    installCommands: [
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", `${label}.timer`] },
    ],
    removeCommands: [
      { command: "systemctl", args: ["--user", "disable", "--now", `${label}.timer`], ignoreFailure: true },
    ],
    cleanupCommands: [{ command: "systemctl", args: ["--user", "daemon-reload"] }],
  };
}

function windowsPlan(homeDir: string, command: string[], intervalMinutes: number): LibraryKeepalivePlan {
  const label = "HKU CLI Library Keepalive";
  const path = join(homeDir, "AppData", "Local", "hku-cli", "keepalive", "library.xml");
  const argumentsText = command.slice(1).map(windowsArgument).join(" ");
  const startBoundary = new Date(Date.now() + 60_000).toLocaleString("sv-SE").replace(" ", "T");
  const task = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    `<Triggers><TimeTrigger><StartBoundary>${startBoundary}</StartBoundary>`,
    `<Repetition><Interval>PT${intervalMinutes}M</Interval></Repetition></TimeTrigger></Triggers>`,
    "<Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType></Principal></Principals>",
    "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable></Settings>",
    `<Actions Context="Author"><Exec><Command>${xml(command[0]!)}</Command><Arguments>${xml(argumentsText)}</Arguments></Exec></Actions>`,
    "</Task>",
    "",
  ].join("\r\n");
  return {
    platform: "win32",
    label,
    scheduler: "Windows Task Scheduler",
    schedule: `every ${intervalMinutes} minutes`,
    path,
    logPath: "Task Scheduler history",
    intervalMinutes,
    command,
    files: [{ path, content: task, encoding: "utf16le" }],
    installCommands: [{ command: "schtasks.exe", args: ["/Create", "/TN", label, "/XML", path, "/F"] }],
    removeCommands: [{ command: "schtasks.exe", args: ["/Delete", "/TN", label, "/F"], ignoreFailure: true }],
    cleanupCommands: [],
  };
}

function resultFor(plan: LibraryKeepalivePlan): LibraryKeepaliveResult {
  return {
    installed: true,
    scheduler: plan.scheduler,
    schedule: plan.schedule,
    label: plan.label,
    path: plan.path,
    log_path: plan.logPath,
    interval_minutes: plan.intervalMinutes,
    command: plan.command,
  };
}

function runCommands(commands: readonly LibraryKeepaliveCommand[], runCommand: typeof spawnSync): void {
  for (const item of commands) {
    const result = runCommand(item.command, item.args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as SpawnSyncReturns<string>;
    if (!item.ignoreFailure && (result.error || result.status !== 0)) {
      const detail = (result.stderr || result.stdout || result.error?.message || "").trim();
      throw new Error(
        `Failed to run ${item.command}${result.status === null ? "" : ` (exit ${result.status})`}`
        + `${detail ? `: ${detail}` : "."}`,
      );
    }
  }
}

function normalizePlatform(platform: NodeJS.Platform): LibraryKeepalivePlatform {
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new Error(`HKUL keepalive scheduling is not supported on ${platform}.`);
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function windowsArgument(value: string): string {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}
