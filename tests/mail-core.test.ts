import { describe, expect, it } from "vitest";

import {
  createMailConfig,
  decodeMimeMessage,
  normalizeAddresses,
  validateSendMail,
} from "../src/mail-core.js";

describe("163 mail core", () => {
  it("creates the IMAP and SMTP configuration without exposing credentials", () => {
    const config = createMailConfig("student@163.com", "secret", {
      HKU_MAIL_IMAP_HOST: "imap.example.test",
      HKU_MAIL_IMAP_PORT: "1993",
    });
    expect(config).toMatchObject({
      username: "student@163.com",
      authorizationCode: "secret",
      imapHost: "imap.example.test",
      imapPort: 1993,
      smtpHost: "smtp.163.com",
      smtpPort: 465,
    });
  });

  it("decodes encoded headers and multipart message bodies", () => {
    const raw = Buffer.from([
      "From: =?UTF-8?B?5byg5LiJ?= <student@163.com>",
      "To: recipient@hku.hk",
      "Subject: =?UTF-8?B?5LuK5pel6YKu5Lu2?=",
      "Date: Mon, 19 Oct 2026 06:12:13 +0800",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="part"',
      "",
      "--part",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("正文内容", "utf8").toString("base64"),
      "--part",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      "<p>HTML fallback</p>",
      "--part--",
      "",
    ].join("\r\n"), "utf8");

    const decoded = decodeMimeMessage(raw);
    expect(decoded).toMatchObject({
      subject: "今日邮件",
      from: "张三 <student@163.com>",
      to: ["recipient@hku.hk"],
      body: "正文内容",
      bodyType: "text",
    });
  });

  it("decodes HTML when no plain-text part exists", () => {
    const raw = Buffer.from([
      "From: sender@163.com",
      "Subject: HTML",
      "Content-Type: text/html; charset=UTF-8",
      "",
      "<p>Hello<br>world &amp; friends</p>",
    ].join("\r\n"), "utf8");
    expect(decodeMimeMessage(raw).body).toBe("Hello\nworld & friends");
  });

  it("validates recipients and normalizes addresses", () => {
    expect(normalizeAddresses(["A@163.COM, b@163.com", "a@163.com"])).toEqual(["a@163.com", "b@163.com"]);
    expect(() => normalizeAddresses(["not-an-address"])).toThrow("Invalid email address");
    expect(validateSendMail({
      to: ["target@hku.hk"],
      subject: "Hello",
      body: "Body",
    })).toMatchObject({ to: ["target@hku.hk"], subject: "Hello" });
  });
});
