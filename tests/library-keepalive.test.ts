import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLibraryKeepalivePlan,
  installLibraryKeepalive,
  uninstallLibraryKeepalive,
} from "../src/library-keepalive.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

describe("HKUL keepalive scheduler", () => {
  it("builds a Windows task that touches only the saved session", () => {
    const plan = buildLibraryKeepalivePlan({
      homeDir: "C:\\Users\\student",
      platform: "win32",
      intervalMinutes: 20,
      executable: "C:\\Program Files\\nodejs\\node.exe",
      executableArgs: ["C:\\Tools\\hku-cli\\dist\\hku.js"],
    });

    expect(plan.label).toBe("HKU CLI Library Keepalive");
    expect(plan.scheduler).toBe("Windows Task Scheduler");
    expect(plan.command).toEqual([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Tools\\hku-cli\\dist\\hku.js",
      "library",
      "keepalive",
      "--json",
    ]);
    expect(plan.files[0]?.content).toContain("<Interval>PT20M</Interval>");
    expect(plan.files[0]?.content).toContain("library keepalive --json");
    expect(plan.files[0]?.content).not.toContain("--renew");
    expect(plan.installCommands[0]).toMatchObject({ command: "schtasks.exe", args: expect.arrayContaining(["/Create"]) });
  });

  it("builds native launchd and systemd jobs", () => {
    const mac = buildLibraryKeepalivePlan({
      homeDir: "/Users/student",
      platform: "darwin",
      uid: 501,
      executable: "/opt/homebrew/bin/node",
      executableArgs: ["/opt/hku/dist/hku.js"],
    });
    expect(mac.path).toContain("com.hku-cli.library-keepalive.plist");
    expect(mac.files[0]?.content).toContain("<key>StartInterval</key><integer>1800</integer>");
    expect(mac.installCommands[1]?.args.slice(0, 2)).toEqual(["bootstrap", "gui/501"]);

    const linux = buildLibraryKeepalivePlan({
      homeDir: "/home/student",
      platform: "linux",
      executable: "/usr/bin/node",
      executableArgs: ["/opt/hku/dist/hku.js"],
    });
    expect(linux.path).toContain("hku-cli-library-keepalive.timer");
    expect(linux.files.map(file => file.path)).toHaveLength(2);
    expect(linux.files[0]?.content).toContain("library");
    expect(linux.installCommands[1]?.args).toContain("hku-cli-library-keepalive.timer");
  });

  it("installs and removes scheduler files with registered commands", async () => {
    const home = await mkdtemp(join(tmpdir(), "hku-library-keepalive-"));
    homes.push(home);
    const runCommand = vi.fn(() => ({ status: 0 })) as never;
    const result = await installLibraryKeepalive({
      homeDir: home,
      platform: "win32",
      executable: "C:\\node.exe",
      executableArgs: ["C:\\hku.js"],
      runCommand,
    });

    expect(result.installed).toBe(true);
    expect(await readFile(result.path, "utf16le")).toContain("library keepalive --json");
    expect(runCommand).toHaveBeenCalledWith(
      "schtasks.exe",
      expect.arrayContaining(["/Create", "/TN", "HKU CLI Library Keepalive"]),
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    const removed = await uninstallLibraryKeepalive({
      homeDir: home,
      platform: "win32",
      executable: "C:\\node.exe",
      executableArgs: ["C:\\hku.js"],
      runCommand,
    });
    expect(removed.installed).toBe(false);
    await expect(readFile(result.path, "utf16le")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects intervals that could overload the booking system", () => {
    expect(() => buildLibraryKeepalivePlan({ platform: "linux", intervalMinutes: 1 })).toThrow(/5 to 1440/u);
    expect(() => buildLibraryKeepalivePlan({ platform: "linux", intervalMinutes: 1_441 })).toThrow(/5 to 1440/u);
  });
});
