import { describe, expect, it } from "vitest";

import { aggregateMail, normalizeMessage } from "../src/hku-mail-core.js";
import { parseMailSource } from "../src/hku-mail.js";

describe("HKU mail aggregation", () => {
  it("normalizes sender, category and action state", () => {
    const message = normalizeMessage({
      id: "m1",
      subject: "Library booking reminder",
      from: { name: "HKU Libraries", address: "LIBRARY@HKU.HK" },
      receivedAt: "2026-10-18T01:00:00Z",
      isRead: false,
      importance: "normal",
      preview: "Please confirm your study room booking.",
    });

    expect(message).toMatchObject({
      category: "library",
      hkuRelated: true,
      actionNeeded: true,
      from: { address: "library@hku.hk" },
    });
  });

  it("deduplicates messages, enforces the window and ranks senders", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const digest = aggregateMail([
      {
        id: "old",
        subject: "Old mail",
        from: { address: "old@example.com" },
        receivedAt: "2026-10-16T12:00:00Z",
      },
      {
        id: "new",
        subject: "Moodle assignment due",
        conversationId: "thread-1",
        from: { address: "moodle@hku.hk" },
        receivedAt: "2026-10-18T08:00:00Z",
        isRead: false,
      },
      {
        id: "new",
        subject: "Moodle assignment due",
        conversationId: "thread-1",
        from: { address: "moodle@hku.hk" },
        receivedAt: "2026-10-18T08:00:00Z",
        isRead: false,
      },
      {
        id: "reply",
        subject: "Re: Moodle assignment due",
        conversationId: "thread-1",
        from: { address: "teacher@hku.hk" },
        receivedAt: "2026-10-18T09:00:00Z",
        isRead: true,
      },
    ], { hours: 24, now });

    expect(digest.totals).toMatchObject({
      messages: 2,
      unread: 1,
      hku_related: 2,
      action_needed: 2,
    });
    expect(digest.threads[0]).toMatchObject({ conversation_id: "thread-1", count: 2, unread: 1 });
    expect(digest.top_domains).toContainEqual({ key: "hku.hk", count: 2 });
  });

  it("parses an RFC 822 message from the 163 mailbox", async () => {
    const message = await parseMailSource([
      "From: HKU Moodle <moodle@hku.hk>",
      "To: Student <18301713463@163.com>",
      "Subject: Moodle assignment due",
      "Date: Sat, 18 Oct 2026 09:00:00 +0800",
      "Message-ID: <m1@hku.hk>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please submit the assignment before Friday.",
    ].join("\r\n"), {
      uid: 42,
      mailbox: "INBOX",
      flags: new Set<string>(),
      internalDate: "2026-10-18T01:00:00Z",
    });

    expect(message).toMatchObject({
      id: "<m1@hku.hk>",
      subject: "Moodle assignment due",
      from: { address: "moodle@hku.hk" },
      receivedAt: "2026-10-18T01:00:00.000Z",
      isRead: false,
      mailbox: "INBOX",
    });
    expect(message.preview).toContain("Please submit the assignment");
  });
});
