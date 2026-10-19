import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

describe("HKU CLI service commands", () => {
  it("describes mail and library in the command tree", async () => {
    const stdout = buffer(false);
    await expect(runCli(["node", "hku", "commands", "--json"], {
      stdout,
      stderr: buffer(false),
    })).resolves.toBe(0);
    const tree = JSON.parse(stdout.text()) as {
      name: string;
      commands: Array<{ name: string; commands?: Array<{ name: string }> }>;
    };
    expect(tree.name).toBe("hku");
    expect(tree.commands.map(command => command.name)).toEqual(expect.arrayContaining(["mail", "library", "status", "units"]));
    expect(tree.commands.find(command => command.name === "mail")?.commands?.map(command => command.name)).toEqual(
      expect.arrayContaining(["login", "status", "inbox", "read", "send"]),
    );
    expect(tree.commands.find(command => command.name === "library")?.commands?.map(command => command.name)).toEqual(
      expect.arrayContaining(["login", "logout", "keepalive", "facilities", "slots", "book", "bookings", "cancel"]),
    );
  });

  it("keeps the moodle alias for existing commands", async () => {
    const stdout = buffer(false);
    await expect(runCli(["node", "hku", "moodle", "--help"], {
      stdout,
      stderr: buffer(false),
    })).resolves.toBe(0);
    expect(stdout.text()).toContain("Moodle");
  });

  it("previews email without reading credentials or sending", async () => {
    const stdout = buffer(false);
    await expect(runCli([
      "node",
      "hku",
      "mail",
      "send",
      "--to",
      "student@connect.hku.hk",
      "--subject",
      "Library room",
      "--body",
      "See you at 10:00.",
      "--dry-run",
      "--json",
    ], {
      stdout,
      stderr: buffer(false),
      stdin: { isTTY: false } as NodeJS.ReadStream,
    })).resolves.toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      planned: {
        to: ["student@connect.hku.hk"],
        subject: "Library room",
        body: "See you at 10:00.",
      },
    });
  });

  it("requires an explicit --yes before non-interactive email sending", async () => {
    const stderr = buffer(false);
    await expect(runCli([
      "node",
      "hku",
      "mail",
      "send",
      "--to",
      "student@connect.hku.hk",
      "--subject",
      "Hello",
      "--body",
      "Body",
      "--json",
    ], {
      stdout: buffer(false),
      stderr,
      stdin: { isTTY: false } as NodeJS.ReadStream,
    })).resolves.toBe(2);
    expect(JSON.parse(stderr.text())).toMatchObject({ error: { code: "usage" } });
  });
});

function buffer(isTTY: boolean) {
  let value = "";
  return {
    isTTY,
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text: () => value,
  };
}
