import { connect as connectTls, type TLSSocket } from "node:tls";
import { parse as parseHtml } from "node-html-parser";

import { AuthError, CliError, UsageError } from "./errors.js";

export const DEFAULT_IMAP_HOST = "imap.163.com";
export const DEFAULT_IMAP_PORT = 993;
export const DEFAULT_SMTP_HOST = "smtp.163.com";
export const DEFAULT_SMTP_PORT = 465;

export interface MailConfig {
  username: string;
  authorizationCode: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export interface MailMessageSummary {
  uid: string;
  subject: string;
  from: string;
  to: string[];
  received_at?: string;
  unread: boolean;
}

export interface MailMessage extends MailMessageSummary {
  body: string;
  body_type: "text" | "html";
  attachments: MailAttachmentInfo[];
}

export interface MailAttachmentInfo {
  index: number;
  name: string;
  mime_type: string;
  bytes: number;
}

export interface MailAttachment extends MailAttachmentInfo {
  data: Buffer;
}

export interface SendMailInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  html?: boolean;
}

interface ImapSearchOptions {
  limit?: number;
  unread?: boolean;
  search?: string;
  searchBody?: boolean;
  since?: Date;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const NETWORK_TIMEOUT_MS = 30_000;

export function createMailConfig(
  username: string,
  authorizationCode: string,
  env: Record<string, string | undefined> = process.env,
): MailConfig {
  const normalizedUser = username.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedUser)) {
    throw new UsageError("An email username is required for the 163 mailbox.");
  }
  if (!authorizationCode.trim()) {
    throw new AuthError("The 163 mailbox authorization code is required.");
  }
  return {
    username: normalizedUser,
    authorizationCode: authorizationCode.trim(),
    imapHost: env.HKU_MAIL_IMAP_HOST?.trim() || DEFAULT_IMAP_HOST,
    imapPort: port(env.HKU_MAIL_IMAP_PORT, DEFAULT_IMAP_PORT),
    smtpHost: env.HKU_MAIL_SMTP_HOST?.trim() || DEFAULT_SMTP_HOST,
    smtpPort: port(env.HKU_MAIL_SMTP_PORT, DEFAULT_SMTP_PORT),
  };
}

export async function listMailMessages(
  config: MailConfig,
  options: ImapSearchOptions = {},
): Promise<MailMessageSummary[]> {
  const client = await ImapClient.connect(config);
  try {
    const uids = await client.search({
      ...(options.unread ? { unread: true } : {}),
      ...(options.since ? { since: options.since } : {}),
    });
    const limit = Math.max(1, Math.min(500, options.limit ?? 20));
    const poolSize = options.search && options.searchBody ? Math.max(limit, 200) : limit;
    const wanted = uids.slice(-poolSize).reverse();
    const query = options.search?.trim().toLowerCase();
    const messages: MailMessageSummary[] = [];
    for (const uid of wanted) {
      const item = options.searchBody ? await client.message(uid) : await client.header(uid);
      if (!item) continue;
      const summary = toSummary(item);
      const searchable = options.searchBody
        ? `${summary.from}\n${summary.subject}\n${decodeMimeMessage(item.raw).body}`
        : `${summary.from}\n${summary.subject}`;
      if (query && !searchable.toLowerCase().includes(query)) continue;
      messages.push(summary);
      if (messages.length >= limit) break;
    }
    return messages;
  } finally {
    await client.close();
  }
}

export async function getMailMessage(config: MailConfig, uid: string): Promise<MailMessage> {
  if (!/^\d+$/u.test(uid)) throw new UsageError("Mail message id must be an IMAP UID.");
  const client = await ImapClient.connect(config);
  try {
    const item = await client.message(uid);
    if (!item) throw new CliError("not_found", `Mail message ${uid} was not found.`);
    const summary = toSummary(item);
    const decoded = decodeMimeMessage(item.raw);
    return {
      ...summary,
      subject: summary.subject || decoded.subject || "(no subject)",
      from: summary.from || decoded.from,
      to: summary.to.length ? summary.to : decoded.to,
      body: decoded.body,
      body_type: decoded.bodyType,
      attachments: parseMailAttachments(item.raw).map(({ data: _data, ...info }) => info),
    };
  } finally {
    await client.close();
  }
}

export async function getMailAttachments(config: MailConfig, uid: string): Promise<MailAttachment[]> {
  if (!/^\d+$/u.test(uid)) throw new UsageError("Mail message id must be an IMAP UID.");
  const client = await ImapClient.connect(config);
  try {
    const item = await client.message(uid);
    if (!item) throw new CliError("not_found", `Mail message ${uid} was not found.`);
    return parseMailAttachments(item.raw);
  } finally {
    await client.close();
  }
}

export function parseMailAttachments(raw: Buffer): MailAttachment[] {
  const headers = parseHeaders(raw);
  const bodyBytes = afterHeaders(raw);
  const attachments: MailAttachment[] = [];
  collectTextParts(headers, bodyBytes, [], [], attachments);
  return attachments.map((attachment, index) => ({ ...attachment, index }));
}

export async function verifyMailLogin(config: MailConfig): Promise<void> {
  const client = await ImapClient.connect(config);
  await client.close();
}

export async function verifyMailSendLogin(config: MailConfig): Promise<void> {
  const client = await SmtpClient.connect(config);
  try {
    await client.login(config.username, config.authorizationCode);
  } finally {
    await client.close();
  }
}

export async function sendMail(
  config: MailConfig,
  input: SendMailInput,
): Promise<{ sent: true; to: string[]; subject: string }> {
  const request = validateSendMail(input);
  const client = await SmtpClient.connect(config);
  try {
    await client.login(config.username, config.authorizationCode);
    await client.mailFrom(config.username);
    for (const address of [...request.to, ...(request.cc ?? [])]) await client.recipient(address);
    const mime = buildMessage(config.username, request);
    await client.data(mime);
    return { sent: true, to: request.to, subject: request.subject };
  } finally {
    await client.close();
  }
}

export function validateSendMail(input: SendMailInput): SendMailInput {
  const to = normalizeAddresses(input.to);
  const cc = normalizeAddresses(input.cc ?? []);
  if (!to.length) throw new UsageError("Email needs at least one recipient.", "Pass --to name@163.com.");
  if (!input.subject.trim()) throw new UsageError("Email subject cannot be empty.");
  if (!input.body.trim()) throw new UsageError("Email body cannot be empty.");
  if (/[\r\n]/u.test(input.subject)) throw new UsageError("Email subject cannot contain a newline.");
  return { ...input, to, cc: cc.length ? cc : undefined, subject: input.subject.trim() };
}

export function normalizeAddresses(values: readonly string[]): string[] {
  const addresses = values
    .flatMap(value => value.split(","))
    .map(value => value.trim())
    .filter(Boolean);
  const invalid = addresses.find(value => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value));
  if (invalid) throw new UsageError(`Invalid email address: ${invalid}`);
  return [...new Set(addresses.map(value => value.toLowerCase()))];
}

export function decodeMimeMessage(raw: Buffer): {
  subject: string;
  from: string;
  to: string[];
  received_at?: string;
  body: string;
  bodyType: "text" | "html";
} {
  const headers = parseHeaders(raw);
  const bodyBytes = afterHeaders(raw);
  const plain: string[] = [];
  const rich: string[] = [];
  collectTextParts(headers, bodyBytes, plain, rich);
  const html = rich.map(htmlToText).find(Boolean);
  return {
    subject: decodeMimeWords(headers.get("subject") ?? ""),
    from: decodeMimeWords(headers.get("from") ?? ""),
    to: splitAddresses(decodeMimeWords(headers.get("to") ?? "")),
    ...(parseMailDate(headers.get("date")) ? { received_at: parseMailDate(headers.get("date"))! } : {}),
    body: (plain.find(value => value.trim()) || html || "").trim(),
    bodyType: "text",
  };
}

class ImapClient {
  private constructor(
    private readonly socket: TLSSocket,
    private buffer = Buffer.alloc(0),
  ) {}

  static async connect(config: MailConfig): Promise<ImapClient> {
    const socket = await tlsSocket(config.imapHost, config.imapPort);
    const client = new ImapClient(socket);
    try {
      await client.expectGreeting("IMAP");
      // NetEase rejects clients that omit the IMAP ID extension.
      await client.rawCommand("ID", '("name" "hku-cli" "version" "0.11.0" "vendor" "hku-cli")', true);
      await client.rawCommand("LOGIN", `${quote(config.username)} ${quote(config.authorizationCode)}`);
      await client.rawCommand("EXAMINE", quote("INBOX"));
      return client;
    } catch (error) {
      socket.destroy();
      if (error instanceof CliError) throw error;
      throw new AuthError("Could not sign in to the 163 mailbox.", "Check the mailbox address and authorization code.");
    }
  }

  async search(options: { unread?: boolean; since?: Date }): Promise<string[]> {
    const criteria = [
      ...(options.unread ? ["UNSEEN"] : []),
      ...(options.since ? ["SINCE", imapDate(options.since)] : []),
    ];
    const response = await this.command(`UID SEARCH ${criteria.length ? criteria.join(" ") : "ALL"}`);
    const line = response.toString("latin1").split(/\r?\n/u).find(value => /^\* SEARCH\b/iu.test(value));
    return line ? line.replace(/^\* SEARCH\s*/iu, "").trim().split(/\s+/u).filter(Boolean) : [];
  }

  async header(uid: string): Promise<{ uid: string; raw: Buffer; flags: string[]; internalDate?: string } | null> {
    return this.fetch(uid, "FLAGS INTERNALDATE BODY.PEEK[HEADER.FIELDS (DATE FROM TO SUBJECT)]");
  }

  async message(uid: string): Promise<{ uid: string; raw: Buffer; flags: string[]; internalDate?: string } | null> {
    return this.fetch(uid, "FLAGS INTERNALDATE BODY.PEEK[]");
  }

  async close(): Promise<void> {
    try { await this.rawCommand("LOGOUT"); } catch { /* Connection close is best-effort. */ }
    this.socket.end();
    this.socket.destroy();
  }

  private async fetch(uid: string, fields: string): Promise<{ uid: string; raw: Buffer; flags: string[]; internalDate?: string } | null> {
    const response = await this.command(`UID FETCH ${uid} (${fields})`);
    const text = response.toString("latin1");
    const flags = /FLAGS \(([^)]*)\)/iu.exec(text)?.[1]?.split(/\s+/u).filter(Boolean) ?? [];
    const internalDate = /INTERNALDATE "([^"]+)"/iu.exec(text)?.[1];
    const literal = /\{(\d+)\}\r\n/gu.exec(text);
    if (!literal) return null;
    const start = literal.index + literal[0].length;
    const end = start + Number(literal[1]);
    return {
      uid,
      raw: response.subarray(start, end),
      flags,
      ...(internalDate ? { internalDate } : {}),
    };
  }

  private async rawCommand(name: string, args = "", tolerateFailure = false): Promise<Buffer> {
    try {
      return await this.command(args ? `${name} ${args}` : name);
    } catch (error) {
      if (tolerateFailure) return Buffer.alloc(0);
      throw error;
    }
  }

  private async command(command: string): Promise<Buffer> {
    if (/[\r\n]/u.test(command)) throw new Error("Invalid IMAP command.");
    const tag = `A${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    this.socket.write(`${tag} ${command}\r\n`);
    const response = await this.readUntil(line => line.startsWith(`${tag} `));
    const final = response.toString("latin1").split(/\r?\n/u).find(line => line.startsWith(`${tag} `)) ?? "";
    if (!/^A\S+ OK\b/iu.test(final)) {
      throw new AuthError(
        sanitizeProtocolError(final) || "The 163 mailbox rejected the request.",
        "Run `hku mail login` if the authorization code changed.",
      );
    }
    return response;
  }

  private async expectGreeting(kind: string): Promise<void> {
    const line = await this.readLine();
    if (!/^\* OK\b/iu.test(line)) throw new AuthError(`The ${kind} server did not accept the connection.`);
  }

  private async readLine(): Promise<string> {
    while (!this.buffer.includes(Buffer.from("\r\n"))) await this.readMore();
    const end = this.buffer.indexOf(Buffer.from("\r\n"));
    const line = this.buffer.subarray(0, end).toString("latin1");
    this.buffer = this.buffer.subarray(end + 2);
    return line;
  }

  private async readUntil(done: (line: string) => boolean): Promise<Buffer> {
    for (;;) {
      const text = this.buffer.toString("latin1");
      const lines = text.split(/\r?\n/u);
      if (lines.some(done)) {
        const output = this.buffer;
        this.buffer = Buffer.alloc(0);
        return output;
      }
      await this.readMore();
    }
  }

  private readMore(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new CliError("network", "The 163 IMAP server did not respond within 30s."));
      }, NETWORK_TIMEOUT_MS);
      const onData = (chunk: Buffer) => {
        cleanup();
        this.buffer = Buffer.concat([this.buffer, chunk]);
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new CliError("network", `The 163 IMAP connection failed: ${error.message}`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off("data", onData);
        this.socket.off("error", onError);
      };
      this.socket.once("data", onData);
      this.socket.once("error", onError);
    });
  }
}

class SmtpClient {
  private constructor(
    private readonly socket: TLSSocket,
    private buffer = "",
  ) {}

  static async connect(config: MailConfig): Promise<SmtpClient> {
    const socket = await tlsSocket(config.smtpHost, config.smtpPort);
    const client = new SmtpClient(socket);
    try {
      await client.reply("220");
      await client.command("EHLO hku-cli");
      return client;
    } catch (error) {
      socket.destroy();
      if (error instanceof CliError) throw error;
      throw new AuthError("Could not connect to the 163 SMTP server.");
    }
  }

  async login(username: string, authorizationCode: string): Promise<void> {
    try {
      await this.command("AUTH LOGIN", "334");
      await this.command(Buffer.from(username).toString("base64"), "334");
      await this.command(Buffer.from(authorizationCode).toString("base64"), "235");
    } catch (error) {
      throw new AuthError("The 163 SMTP server rejected the authorization code.", "Check the mailbox settings and authorization code.");
    }
  }

  async mailFrom(address: string): Promise<void> {
    await this.command(`MAIL FROM:<${address}>`);
  }

  async recipient(address: string): Promise<void> {
    await this.command(`RCPT TO:<${address}>`);
  }

  async data(message: string): Promise<void> {
    await this.command("DATA", "354");
    const normalized = message.replace(/\r?\n/gu, "\r\n").replace(/^\./gmu, "..");
    this.socket.write(`${normalized}\r\n.\r\n`);
    await this.reply("250");
  }

  async close(): Promise<void> {
    try { await this.command("QUIT"); } catch { /* Connection close is best-effort. */ }
    this.socket.end();
    this.socket.destroy();
  }

  private async command(value: string, expected = "250"): Promise<string> {
    if (/[\r\n]/u.test(value)) throw new UsageError("Invalid SMTP command.");
    this.socket.write(`${value}\r\n`);
    return this.reply(expected);
  }

  private async reply(expected: string): Promise<string> {
    for (;;) {
      while (!this.buffer.includes("\r\n")) {
        const chunk = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new CliError("network", "The 163 SMTP server did not respond within 30s.")), NETWORK_TIMEOUT_MS);
          this.socket.once("data", (data: Buffer) => {
            clearTimeout(timer);
            resolve(data.toString("utf8"));
          });
          this.socket.once("error", (error: Error) => {
            clearTimeout(timer);
            reject(new CliError("network", `The 163 SMTP connection failed: ${error.message}`));
          });
        });
        this.buffer += chunk;
      }
      const end = this.buffer.indexOf("\r\n");
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      if (line.startsWith(`${expected} `)) return line;
      if (!line.startsWith(`${expected}-`)) {
        throw new AuthError(`The 163 SMTP server rejected the request (${line.slice(0, 3)}).`);
      }
    }
  }
}

async function tlsSocket(host: string, port: number): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = connectTls({ host, port, servername: host, rejectUnauthorized: true });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new CliError("network", `Could not connect to ${host}:${port} within 30s.`));
    }, NETWORK_TIMEOUT_MS);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", error => {
      clearTimeout(timer);
      reject(new CliError("network", `Could not connect to ${host}:${port}: ${error.message}`));
    });
  });
}

function toSummary(item: { uid: string; raw: Buffer; flags: string[]; internalDate?: string }): MailMessageSummary {
  const headers = parseHeaders(item.raw);
  const parsedDate = parseMailDate(item.internalDate || headers.get("date"));
  return {
    uid: item.uid,
    subject: decodeMimeWords(headers.get("subject") ?? "") || "(no subject)",
    from: decodeMimeWords(headers.get("from") ?? ""),
    to: splitAddresses(decodeMimeWords(headers.get("to") ?? "")),
    ...(parsedDate ? { received_at: parsedDate } : {}),
    unread: !item.flags.some(flag => flag.toLowerCase() === "\\seen"),
  };
}

function parseHeaders(raw: Buffer): Map<string, string> {
  const separator = raw.indexOf(Buffer.from("\r\n\r\n"));
  const head = raw.subarray(0, separator >= 0 ? separator : raw.length).toString("latin1");
  const headers = new Map<string, string>();
  let current = "";
  for (const line of head.split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line) && current) {
      headers.set(current, `${headers.get(current) ?? ""} ${line.trim()}`);
      continue;
    }
    const match = /^([^:]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    current = match[1].toLowerCase();
    headers.set(current, match[2]);
  }
  return headers;
}

function afterHeaders(raw: Buffer): Buffer {
  const separator = raw.indexOf(Buffer.from("\r\n\r\n"));
  return separator >= 0 ? raw.subarray(separator + 4) : Buffer.alloc(0);
}

function collectTextParts(
  headers: Map<string, string>,
  body: Buffer,
  plain: string[],
  rich: string[],
  attachments: Omit<MailAttachment, "index">[] = [],
): void {
  const contentType = parseContentType(headers.get("content-type") ?? "text/plain; charset=UTF-8");
  if (contentType.type.startsWith("multipart/") && contentType.params.boundary) {
    for (const part of splitMultipart(body, contentType.params.boundary)) {
      const partSeparator = part.indexOf(Buffer.from("\r\n\r\n"));
      const partHead = part.subarray(0, partSeparator >= 0 ? partSeparator : part.length);
      const partBody = partSeparator >= 0 ? part.subarray(partSeparator + 4) : Buffer.alloc(0);
      collectTextParts(parseHeaders(Buffer.concat([partHead, Buffer.from("\r\n\r\n")])), partBody, plain, rich, attachments);
    }
    return;
  }
  const disposition = headers.get("content-disposition") ?? "";
  const filename = contentType.params.name || dispositionParameter(disposition, "filename");
  if (/^attachment\b/iu.test(disposition) || filename) {
    const decoded = decodeTransfer(body, headers.get("content-transfer-encoding") ?? "7bit");
    attachments.push({
      name: decodeMimeWords(filename || `attachment-${attachments.length + 1}`),
      mime_type: contentType.type || "application/octet-stream",
      bytes: decoded.byteLength,
      data: decoded,
    });
    return;
  }
  if (!contentType.type.startsWith("text/")) return;
  const decoded = decodeTransfer(body, headers.get("content-transfer-encoding") ?? "7bit");
  const text = decodeCharset(decoded, contentType.params.charset || "utf-8");
  if (contentType.type === "text/html") rich.push(text);
  else plain.push(text);
}

function dispositionParameter(value: string, name: string): string {
  const match = new RegExp(`(?:^|;)\\s*${name}=(?:"([^"]*)"|([^;]*))`, "iu").exec(value);
  return (match?.[1] ?? match?.[2] ?? "").trim();
}

function splitMultipart(body: Buffer, boundary: string): Buffer[] {
  const marker = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let start = body.indexOf(marker);
  while (start >= 0) {
    start += marker.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    if (body.subarray(start, start + 2).toString() === "\r\n") start += 2;
    const next = body.indexOf(marker, start);
    if (next < 0) break;
    let end = next;
    if (body.subarray(end - 2, end).toString() === "\r\n") end -= 2;
    parts.push(body.subarray(start, end));
    start = next;
  }
  return parts;
}

function parseContentType(value: string): { type: string; params: Record<string, string> } {
  const [type, ...parameters] = value.split(";").map(part => part.trim());
  const params: Record<string, string> = {};
  for (const parameter of parameters) {
    const match = /^([^=]+)=(?:"([^"]*)"|([^;]*))$/u.exec(parameter);
    if (match) params[match[1].trim().toLowerCase()] = (match[2] ?? match[3] ?? "").trim();
  }
  return { type: type.toLowerCase(), params };
}

function decodeTransfer(value: Buffer, encoding: string): Buffer {
  const normalized = encoding.trim().toLowerCase();
  if (normalized === "base64") {
    return Buffer.from(value.toString("ascii").replace(/[^A-Za-z0-9+/=]/gu, ""), "base64");
  }
  if (normalized === "quoted-printable") {
    const text = value.toString("latin1").replace(/=\r?\n/gu, "");
    return Buffer.from(text.replace(/=([0-9A-F]{2})/giu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
  }
  return value;
}

function decodeCharset(value: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset || "utf-8").decode(value);
  } catch {
    return value.toString("utf8");
  }
}

function decodeMimeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/gu, (_, charset: string, encoding: string, data: string) => {
    const bytes = encoding.toUpperCase() === "B"
      ? Buffer.from(data, "base64")
      : Buffer.from(data.replace(/_/gu, " ").replace(/=([0-9A-F]{2})/giu, (__, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
    return decodeCharset(bytes, charset);
  });
}

function htmlToText(value: string): string {
  const root = parseHtml(value);
  for (const node of root.querySelectorAll("script,style")) node.remove();
  return root.textContent.replace(/[ \t\r\f\v]+/gu, " ").replace(/\n\s*\n+/gu, "\n").trim();
}

function splitAddresses(value: string): string[] {
  return value.split(",").map(part => part.trim()).filter(Boolean);
}

function parseMailDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function buildMessage(from: string, input: SendMailInput): string {
  const subject = `=?UTF-8?B?${Buffer.from(input.subject, "utf8").toString("base64")}?=`;
  const body = Buffer.from(input.body, "utf8").toString("base64").replace(/(.{76})/gu, "$1\r\n");
  return [
    `From: <${from}>`,
    `To: ${input.to.join(", ")}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: ${input.html ? "text/html" : "text/plain"}; charset=UTF-8`,
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

function imapDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    day: "2-digit",
    month: "numeric",
    year: "numeric",
  }).formatToParts(value);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("day")}-${MONTHS[Number(get("month")) - 1]}-${get("year")}`;
}

function quote(value: string): string {
  if (/[\r\n]/u.test(value)) throw new Error("Invalid IMAP value.");
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

function sanitizeProtocolError(value: string): string | undefined {
  return value ? value.replace(/^A\S+\s+(?:NO|BAD)\s*/iu, "").slice(0, 300) : undefined;
}

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}
