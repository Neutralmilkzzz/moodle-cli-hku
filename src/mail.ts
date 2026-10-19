import { AuthError } from "./errors.js";
import {
  createMailConfig,
  getMailMessage,
  listMailMessages,
  sendMail,
  verifyMailLogin,
  verifyMailSendLogin,
  type MailConfig,
  type MailMessage,
  type MailMessageSummary,
  type SendMailInput,
} from "./mail-core.js";
import { deleteSecureState, readSecureState, writeSecureState, type SecureStateOptions } from "./secure-state.js";

const MAIL_STATE_NAME = "mail-session";

export interface StoredMailSession {
  version: 2;
  provider: "163";
  username: string;
  authorization_code: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  saved_at: number;
}

export interface MailServiceOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loginHkuMail(input: {
  username: string;
  authorizationCode: string;
  options?: MailServiceOptions;
}): Promise<StoredMailSession> {
  const config = mailConfig(input.username, input.authorizationCode, input.options);
  await Promise.all([
    verifyMailLogin(config),
    verifyMailSendLogin(config),
  ]);
  const state: StoredMailSession = {
    version: 2,
    provider: "163",
    username: config.username,
    authorization_code: config.authorizationCode,
    imap_host: config.imapHost,
    imap_port: config.imapPort,
    smtp_host: config.smtpHost,
    smtp_port: config.smtpPort,
    saved_at: Date.now(),
  };
  await writeSecureState(MAIL_STATE_NAME, state, secureOptions(input.options));
  return state;
}

export async function getMailStatus(options: MailServiceOptions = {}): Promise<{
  logged_in: boolean;
  provider: "163";
  username?: string;
  imap_ready?: boolean;
  smtp_ready?: boolean;
  saved_at?: string;
}> {
  const config = await storedMailConfig(options).catch(() => null);
  if (!config) return { logged_in: false, provider: "163" };
  try {
    const [imap, smtp] = await Promise.allSettled([
      verifyMailLogin(config),
      verifyMailSendLogin(config),
    ]);
    const state = await readMailState(options);
    return {
      logged_in: imap.status === "fulfilled" && smtp.status === "fulfilled",
      provider: "163",
      username: config.username,
      imap_ready: imap.status === "fulfilled",
      smtp_ready: smtp.status === "fulfilled",
      ...(state?.saved_at ? { saved_at: new Date(state.saved_at).toISOString() } : {}),
    };
  } catch {
    return { logged_in: false, provider: "163", username: config.username };
  }
}

export async function listHkuMail(
  options: MailServiceOptions & {
    limit?: number;
    unread?: boolean;
    search?: string;
    since?: Date;
  } = {},
): Promise<MailMessageSummary[]> {
  const config = await storedMailConfig(options);
  return listMailMessages(config, {
    limit: options.limit,
    unread: options.unread,
    search: options.search,
    since: options.since,
  });
}

export async function readHkuMail(
  uid: string,
  options: MailServiceOptions = {},
): Promise<MailMessage> {
  return getMailMessage(await storedMailConfig(options), uid);
}

export async function sendHkuMail(
  input: SendMailInput,
  options: MailServiceOptions = {},
): Promise<{ sent: true; to: string[]; subject: string }> {
  return sendMail(await storedMailConfig(options), input);
}

export async function logoutHkuMail(options: MailServiceOptions = {}): Promise<void> {
  await deleteSecureState(MAIL_STATE_NAME, secureOptions(options));
}

async function storedMailConfig(options: MailServiceOptions): Promise<MailConfig> {
  const env = options.env ?? process.env;
  if (env.HKU_MAIL_USERNAME && env.HKU_MAIL_AUTH_CODE) {
    return createMailConfig(env.HKU_MAIL_USERNAME, env.HKU_MAIL_AUTH_CODE, env);
  }
  const state = await readMailState(options);
  if (!state) throw new AuthError("The 163 mailbox is not signed in.", "Run `hku mail login --username ADDRESS`.");
  return createMailConfig(state.username, state.authorization_code, {
    ...env,
    HKU_MAIL_IMAP_HOST: env.HKU_MAIL_IMAP_HOST || state.imap_host,
    HKU_MAIL_IMAP_PORT: env.HKU_MAIL_IMAP_PORT || String(state.imap_port),
    HKU_MAIL_SMTP_HOST: env.HKU_MAIL_SMTP_HOST || state.smtp_host,
    HKU_MAIL_SMTP_PORT: env.HKU_MAIL_SMTP_PORT || String(state.smtp_port),
  });
}

async function readMailState(options: MailServiceOptions): Promise<StoredMailSession | null> {
  const state = await readSecureState<StoredMailSession>(MAIL_STATE_NAME, secureOptions(options));
  return state?.version === 2 && state.provider === "163"
    && typeof state.username === "string"
    && typeof state.authorization_code === "string"
    ? state
    : null;
}

function mailConfig(
  username: string,
  authorizationCode: string,
  options: MailServiceOptions = {},
): MailConfig {
  return createMailConfig(username, authorizationCode, options.env ?? process.env);
}

function secureOptions(options?: MailServiceOptions): SecureStateOptions {
  return { ...(options?.homeDir ? { homeDir: options.homeDir } : {}) };
}
