import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";

import { writeFileAtomic } from "./atomic-write.js";
import { AuthError } from "./errors.js";
import type { MailAddress, RawMailMessage } from "./hku-mail-core.js";
import { VERSION } from "./version.js";

export const DEFAULT_IMAP_HOST = "imap.163.com";
export const DEFAULT_IMAP_PORT = 993;

export interface MailAccountConfig {
  version: 1;
  provider: "163";
  username: string;
  host: string;
  port: number;
  secure: boolean;
}

export interface MailAuthOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MailLoginOptions extends MailAuthOptions {
  account?: string;
  password?: string;
  host?: string;
  port?: number;
}

export interface MailStatus {
  signed_in: boolean;
  account?: string;
  provider?: "163";
  host?: string;
  port?: number;
  secret_saved?: boolean;
  config_path: string;
  secret_path: string;
  verified?: boolean;
  mailbox?: string;
  messages?: number;
  error?: string;
}

export interface RecentMailOptions extends MailAuthOptions {
  hours: number;
  limit?: number;
  mailbox?: string;
  password?: string;
  now?: Date;
}

export interface MailConnectionCheck {
  authenticated: true;
  host: string;
  port: number;
  account: string;
  mailbox: string;
  messages: number;
}

export class MailAuthRequiredError extends AuthError {
  constructor(message = "A 163 mailbox authorization code is required to read mail.") {
    super(message, "Run: hku mail auth login --account you@163.com");
    this.name = "MailAuthRequiredError";
  }
}

export function hkuConfigDir(homeDir = homedir()): string {
  return join(homeDir, ".config", "hku-cli");
}

export function mailAccountPath(homeDir = homedir()): string {
  return join(hkuConfigDir(homeDir), "mail-account.json");
}

export function mailSecretPath(homeDir = homedir()): string {
  return join(hkuConfigDir(homeDir), "mail-secret.json");
}

function normalizeMailbox(mailbox?: string): string {
  return mailbox?.trim() || "INBOX";
}

function normalizeAccount(account: string): string {
  const value = account.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new Error(`Expected an email address, got ${JSON.stringify(account)}.`);
  }
  return value;
}

async function ensurePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, content, { mode: 0o600, directoryMode: 0o700 });
  await chmod(path, 0o600).catch(() => undefined);
}

export async function readMailAccount(homeDir = homedir()): Promise<MailAccountConfig | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(mailAccountPath(homeDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<MailAccountConfig>;
    if (
      value.version !== 1
      || value.provider !== "163"
      || typeof value.username !== "string"
      || typeof value.host !== "string"
      || typeof value.port !== "number"
      || typeof value.secure !== "boolean"
    ) {
      return null;
    }
    return {
      version: 1,
      provider: "163",
      username: normalizeAccount(value.username),
      host: value.host,
      port: value.port,
      secure: value.secure,
    };
  } catch {
    return null;
  }
}

async function readSavedPassword(homeDir = homedir()): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(mailSecretPath(homeDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const password = (parsed as { password?: unknown }).password;
    return typeof password === "string" && password ? password : null;
  } catch {
    return null;
  }
}

function envPassword(env: NodeJS.ProcessEnv | undefined): string {
  return env?.HKU_MAIL_PASSWORD?.trim()
    || env?.HKU_163_AUTH_CODE?.trim()
    || "";
}

async function resolvePassword(options: MailAuthOptions & { password?: string }, account?: MailAccountConfig | null): Promise<string> {
  const direct = options.password?.trim()
    || envPassword(options.env)
    || await readSavedPassword(options.homeDir);
  if (direct) return direct;
  throw new MailAuthRequiredError(
    account
      ? `No saved authorization code for ${account.username}. Run: hku mail auth login --account ${account.username}`
      : undefined,
  );
}

export async function mailAuthStatus(options: MailAuthOptions = {}): Promise<MailStatus> {
  const account = await readMailAccount(options.homeDir);
  const saved = await readSavedPassword(options.homeDir);
  return {
    signed_in: Boolean(account && (saved || envPassword(options.env))),
    ...(account ? {
      account: account.username,
      provider: account.provider,
      host: account.host,
      port: account.port,
    } : {}),
    secret_saved: Boolean(saved),
    config_path: mailAccountPath(options.homeDir),
    secret_path: mailSecretPath(options.homeDir),
  };
}

export async function logoutMail(options: MailAuthOptions = {}): Promise<void> {
  await Promise.all([
    rm(mailAccountPath(options.homeDir), { force: true }),
    rm(mailSecretPath(options.homeDir), { force: true }),
  ]);
}

function createImapClient(account: MailAccountConfig, password: string): ImapFlow {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: {
      user: account.username,
      pass: password,
    },
    clientInfo: {
      name: "hku-cli",
      version: VERSION,
      vendor: "hku-cli",
    },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    tls: {
      servername: account.host,
      rejectUnauthorized: true,
    },
  });
}

async function withMailbox<T>(
  account: MailAccountConfig,
  password: string,
  mailbox: string,
  callback: (client: ImapFlow) => Promise<T>,
): Promise<T> {
  const client = createImapClient(account, password);
  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.mailboxOpen(mailbox);
    return await callback(client);
  } catch (error) {
    if (error instanceof MailAuthRequiredError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/auth|login|credential|password|authorization/iu.test(detail)) {
      throw new MailAuthRequiredError(
        `163 IMAP rejected the saved credentials. Enable IMAP/SMTP in 163 webmail and use the client authorization code, not the login password. (${detail})`,
      );
    }
    throw new Error(`163 IMAP request failed: ${detail}`);
  } finally {
    if (connected) await client.logout().catch(() => client.close());
  }
}

async function requireAccount(options: MailAuthOptions): Promise<MailAccountConfig> {
  const account = await readMailAccount(options.homeDir);
  if (!account) {
    throw new MailAuthRequiredError(
      "No 163 mail account is configured. Run: hku mail auth login --account you@163.com",
    );
  }
  return account;
}

async function verifyAccountConnection(
  account: MailAccountConfig,
  password: string,
  mailboxName?: string,
): Promise<MailConnectionCheck> {
  const mailbox = normalizeMailbox(mailboxName);
  return withMailbox(account, password, mailbox, async client => {
    if (!client.mailbox) {
      throw new Error(`Mailbox ${mailbox} did not open.`);
    }
    return {
      authenticated: true,
      host: account.host,
      port: account.port,
      account: account.username,
      mailbox,
      messages: client.mailbox.exists,
    };
  });
}

export async function verifyMailConnection(
  options: MailAuthOptions & { password?: string; mailbox?: string } = {},
): Promise<MailConnectionCheck> {
  const account = await requireAccount(options);
  const password = await resolvePassword(options, account);
  return verifyAccountConnection(account, password, options.mailbox);
}

export async function loginMail(options: MailLoginOptions): Promise<MailStatus> {
  const account = normalizeAccount(
    options.account?.trim()
    || options.env?.HKU_MAIL_ACCOUNT?.trim()
    || "",
  );
  const password = options.password?.trim() || envPassword(options.env);
  if (!password) {
    throw new MailAuthRequiredError(
      "A 163 client authorization code is required. Enable IMAP/SMTP in 163 webmail, then generate an authorization code.",
    );
  }

  const config: MailAccountConfig = {
    version: 1,
    provider: "163",
    username: account,
    host: options.host?.trim() || DEFAULT_IMAP_HOST,
    port: options.port ?? DEFAULT_IMAP_PORT,
    secure: true,
  };
  const check = await verifyAccountConnection(config, password, "INBOX").catch(error => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not sign in to ${config.host} as ${config.username}. Check that IMAP/SMTP is enabled in 163 webmail and that you used the authorization code rather than the account password.\n${detail}`,
    );
  });

  await Promise.all([
    ensurePrivateFile(mailAccountPath(options.homeDir), `${JSON.stringify(config, null, 2)}\n`),
    ensurePrivateFile(mailSecretPath(options.homeDir), `${JSON.stringify({ version: 1, password }, null, 2)}\n`),
  ]);

  return {
    signed_in: true,
    account: config.username,
    provider: config.provider,
    host: config.host,
    port: config.port,
    secret_saved: true,
    config_path: mailAccountPath(options.homeDir),
    secret_path: mailSecretPath(options.homeDir),
    verified: true,
    mailbox: check.mailbox,
    messages: check.messages,
  };
}

function addresses(value?: AddressObject | AddressObject[]): MailAddress[] {
  if (!value) return [];
  const objects = Array.isArray(value) ? value : [value];
  return objects.flatMap(object => object.value ?? []).flatMap(address => {
    const email = address.address?.trim().toLowerCase() ?? "";
    if (!email) return [];
    return [{ name: address.name?.trim() || email, address: email }];
  });
}

function htmlPreview(html: string): string {
  return html
    .replace(/<(?:style|script)\b[^>]*>[\s\S]*?<\/(?:style|script)>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim();
}

function previewOf(message: ParsedMail): string {
  const text = message.text?.trim();
  const value = text || (typeof message.html === "string" ? htmlPreview(message.html) : "");
  return value.replace(/\s+/gu, " ").slice(0, 800);
}

function normalizedSubject(subject: string): string {
  return subject
    .replace(/^(?:(?:re|fw|fwd)\s*:\s*)+/iu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function conversationIdOf(message: ParsedMail, subject: string, fallback: string): string {
  const references = Array.isArray(message.references)
    ? message.references
    : message.references
      ? [message.references]
      : [];
  return references[0]
    || message.inReplyTo
    || message.messageId
    || `subject:${normalizedSubject(subject) || fallback}`;
}

function importanceOf(message: ParsedMail): "low" | "normal" | "high" {
  return message.priority === "high"
    ? "high"
    : message.priority === "low"
      ? "low"
      : "normal";
}

export interface MailSourceMeta {
  uid: number;
  mailbox?: string;
  flags?: Set<string>;
  internalDate?: Date | string;
}

export async function parseMailSource(source: Buffer | string, meta: MailSourceMeta): Promise<RawMailMessage> {
  const parsed = await simpleParser(source);
  const subject = (parsed.subject ?? "").replace(/\s+/gu, " ").trim();
  const received = meta.internalDate
    ? new Date(meta.internalDate)
    : parsed.date ?? new Date();
  const receivedAt = Number.isNaN(received.getTime()) ? new Date().toISOString() : received.toISOString();
  const sentAt = parsed.date && !Number.isNaN(parsed.date.getTime())
    ? parsed.date.toISOString()
    : receivedAt;
  const id = parsed.messageId?.trim() || `${normalizeMailbox(meta.mailbox)}:${meta.uid}`;
  return {
    id,
    conversationId: conversationIdOf(parsed, subject, id),
    subject,
    from: addresses(parsed.from)[0] ?? null,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    receivedAt,
    sentAt,
    isRead: meta.flags?.has("\\Seen") ?? true,
    hasAttachments: (parsed.attachments?.length ?? 0) > 0,
    importance: importanceOf(parsed),
    preview: previewOf(parsed),
    mailbox: normalizeMailbox(meta.mailbox),
  };
}

export async function fetchRecentMail(options: RecentMailOptions): Promise<RawMailMessage[]> {
  const hours = Math.max(1, Math.min(24 * 31, Math.trunc(options.hours)));
  const limit = Math.max(1, Math.min(5000, Math.trunc(options.limit ?? 2000)));
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
  const account = await requireAccount(options);
  const password = await resolvePassword(options, account);
  const mailbox = normalizeMailbox(options.mailbox);

  return withMailbox(account, password, mailbox, async client => {
    // IMAP SEARCH SINCE only compares dates, so start one day early and apply
    // the exact rolling window locally.
    const searchSince = new Date(since.getTime() - 24 * 60 * 60 * 1000);
    const found = await client.search({ since: searchSince }, { uid: true });
    const uids = (Array.isArray(found) ? found : [])
      .sort((left, right) => right - left)
      .slice(0, limit);
    const messages: RawMailMessage[] = [];
    const chunkSize = 50;
    for (let offset = 0; offset < uids.length && messages.length < limit; offset += chunkSize) {
      const chunk = uids.slice(offset, offset + chunkSize);
      for await (const item of client.fetch(
        chunk,
        { uid: true, source: true, flags: true, internalDate: true },
        { uid: true },
      )) {
        if (!item.source) continue;
        const message = await parseMailSource(item.source, {
          uid: item.uid,
          mailbox,
          flags: item.flags,
          internalDate: item.internalDate,
        });
        const receivedAt = message.receivedAt ?? new Date().toISOString();
        message.receivedAt = receivedAt;
        const received = new Date(receivedAt);
        if (Number.isNaN(received.getTime()) || received < since || received > now) continue;
        messages.push(message);
        if (messages.length >= limit) break;
      }
    }
    return messages.sort((left, right) => (right.receivedAt ?? "").localeCompare(left.receivedAt ?? ""));
  });
}
