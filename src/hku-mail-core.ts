export interface MailAddress {
  name: string;
  address: string;
}

/**
 * Provider-neutral message shape. The IMAP adapter produces this after parsing
 * an RFC 822 message, so aggregation stays easy to test without a mailbox.
 */
export interface RawMailMessage {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: Partial<MailAddress> | null;
  to?: Partial<MailAddress>[];
  cc?: Partial<MailAddress>[];
  receivedAt?: string;
  sentAt?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  importance?: "low" | "normal" | "high";
  webLink?: string;
  preview?: string;
  categories?: string[];
  mailbox?: string;
}

export interface MailMessage {
  id: string;
  conversationId: string;
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  receivedAt: string;
  sentAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: "low" | "normal" | "high";
  webLink: string;
  preview: string;
  categories: string[];
  mailbox: string;
  category: MailCategory;
  hkuRelated: boolean;
  actionNeeded: boolean;
}

export type MailCategory =
  | "course"
  | "library"
  | "meeting"
  | "university-admin"
  | "security"
  | "other";

export interface MailCount {
  key: string;
  count: number;
}

export interface MailThread {
  conversation_id: string;
  subject: string;
  count: number;
  unread: number;
  last_received_at: string;
}

export interface MailDigest {
  generated_at: string;
  window: {
    from: string;
    to: string;
    hours: number;
  };
  totals: {
    messages: number;
    unread: number;
    high_importance: number;
    attachments: number;
    hku_related: number;
    action_needed: number;
  };
  by_category: MailCount[];
  top_senders: MailCount[];
  top_domains: MailCount[];
  threads: MailThread[];
  action_items: MailMessage[];
  messages: MailMessage[];
}

const COURSE_TERMS = [
  "moodle",
  "course",
  "lecture",
  "tutorial",
  "assignment",
  "quiz",
  "exam",
  "coursework",
  "grade",
];
const LIBRARY_TERMS = ["library", "booking", "facility", "study room", "room booking"];
const MEETING_TERMS = ["meeting", "invitation", "webinar", "seminar", "zoom", "teams", "forum"];
const ADMIN_TERMS = [
  "registration",
  "enrolment",
  "enrollment",
  "tuition",
  "transcript",
  "graduation",
  "scholarship",
  "student record",
  "fees",
];
const SECURITY_TERMS = [
  "verify",
  "verification",
  "password",
  "sign-in",
  "sign in",
  "security",
  "authentication",
  "mfa",
];
const ACTION_TERMS = [
  "action required",
  "action needed",
  "please complete",
  "please submit",
  "please reply",
  "respond by",
  "due",
  "deadline",
  "reminder",
  "payment",
  "register",
  "registration",
  "confirm",
  "rsvp",
  "urgent",
];

function containsAny(haystack: string, terms: readonly string[]): boolean {
  return terms.some(term => haystack.includes(term));
}

function cleanAddress(value: Partial<MailAddress> | null | undefined): MailAddress | null {
  const address = value?.address?.trim() ?? "";
  if (!address) return null;
  return { name: value?.name?.trim() || address, address: address.toLowerCase() };
}

function recipients(values: Partial<MailAddress>[] | undefined): MailAddress[] {
  return (values ?? []).flatMap(value => {
    const address = cleanAddress(value);
    return address ? [address] : [];
  });
}

export function classifyMail(subject: string, preview: string, from: MailAddress | null): MailCategory {
  const text = `${subject} ${preview} ${from?.address ?? ""}`.toLowerCase();
  if (containsAny(text, LIBRARY_TERMS)) return "library";
  if (containsAny(text, COURSE_TERMS)) return "course";
  if (containsAny(text, ADMIN_TERMS)) return "university-admin";
  if (containsAny(text, SECURITY_TERMS)) return "security";
  if (containsAny(text, MEETING_TERMS)) return "meeting";
  return "other";
}

export function normalizeMessage(message: RawMailMessage): MailMessage {
  const subject = (message.subject ?? "").replace(/\s+/gu, " ").trim();
  const bodyPreview = (message.preview ?? "").replace(/\s+/gu, " ").trim();
  const from = cleanAddress(message.from);
  const text = `${subject} ${bodyPreview} ${from?.address ?? ""}`.toLowerCase();
  return {
    id: message.id,
    conversationId: message.conversationId ?? message.id,
    subject: subject || "(no subject)",
    from,
    to: recipients(message.to),
    cc: recipients(message.cc),
    receivedAt: message.receivedAt ?? message.sentAt ?? "",
    sentAt: message.sentAt ?? message.receivedAt ?? "",
    isRead: message.isRead !== false,
    hasAttachments: message.hasAttachments === true,
    importance: message.importance ?? "normal",
    webLink: message.webLink ?? "",
    preview: bodyPreview,
    categories: message.categories ?? [],
    mailbox: message.mailbox ?? "INBOX",
    category: classifyMail(subject, bodyPreview, from),
    hkuRelated: /(?:^|\.)hku\.hk$/u.test(from?.address.split("@").at(-1) ?? "")
      || /\bhku\b|hong kong university|university of hong kong|moodle\.hku|lib\.hku/iu.test(text),
    actionNeeded: message.isRead === false
      || message.importance === "high"
      || containsAny(text, ACTION_TERMS),
  };
}

function rankedCounts(values: string[], limit: number): MailCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, limit);
}

function threadSummaries(messages: MailMessage[], limit: number): MailThread[] {
  const threads = new Map<string, MailThread>();
  for (const message of messages) {
    const current = threads.get(message.conversationId);
    if (!current) {
      threads.set(message.conversationId, {
        conversation_id: message.conversationId,
        subject: message.subject,
        count: 1,
        unread: message.isRead ? 0 : 1,
        last_received_at: message.receivedAt,
      });
      continue;
    }
    current.count += 1;
    if (!message.isRead) current.unread += 1;
    if (message.receivedAt > current.last_received_at) {
      current.subject = message.subject;
      current.last_received_at = message.receivedAt;
    }
  }
  return [...threads.values()]
    .sort((left, right) => right.last_received_at.localeCompare(left.last_received_at))
    .slice(0, limit);
}

export function aggregateMail(
  rawMessages: RawMailMessage[],
  options: { hours: number; now?: Date; threadLimit?: number },
): MailDigest {
  const now = options.now ?? new Date();
  const from = new Date(now.getTime() - options.hours * 60 * 60 * 1000);
  const unique = new Map<string, MailMessage>();
  for (const raw of rawMessages) {
    const message = normalizeMessage(raw);
    if (!message.receivedAt) continue;
    const received = new Date(message.receivedAt);
    if (Number.isNaN(received.getTime()) || received < from || received > now) continue;
    unique.set(message.id, message);
  }
  const messages = [...unique.values()].sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
  const actionItems = messages.filter(message => message.actionNeeded);
  return {
    generated_at: now.toISOString(),
    window: { from: from.toISOString(), to: now.toISOString(), hours: options.hours },
    totals: {
      messages: messages.length,
      unread: messages.filter(message => !message.isRead).length,
      high_importance: messages.filter(message => message.importance === "high").length,
      attachments: messages.filter(message => message.hasAttachments).length,
      hku_related: messages.filter(message => message.hkuRelated).length,
      action_needed: actionItems.length,
    },
    by_category: rankedCounts(messages.map(message => message.category), 10),
    top_senders: rankedCounts(messages.map(message => message.from?.address ?? "unknown"), 10),
    top_domains: rankedCounts(messages.map(message => message.from?.address.split("@").at(-1) ?? "unknown"), 10),
    threads: threadSummaries(messages, options.threadLimit ?? 10),
    action_items: actionItems,
    messages,
  };
}

export function formatMailDigest(digest: MailDigest): string {
  const lines = [
    `Mail digest: ${digest.window.hours}h ending ${digest.window.to}`,
    `${digest.totals.messages} messages | ${digest.totals.unread} unread | ${digest.totals.hku_related} HKU-related | ${digest.totals.action_needed} need attention`,
  ];
  if (digest.action_items.length) {
    lines.push("", "Needs attention:");
    for (const message of digest.action_items.slice(0, 12)) {
      const sender = message.from?.address ?? "unknown sender";
      lines.push(`- ${message.receivedAt.slice(0, 16).replace("T", " ")} | ${sender} | ${message.subject}`);
    }
  }
  if (digest.top_senders.length) {
    lines.push("", "Top senders:");
    for (const sender of digest.top_senders.slice(0, 8)) lines.push(`- ${sender.key}: ${sender.count}`);
  }
  lines.push("", "Categories:");
  for (const category of digest.by_category) lines.push(`- ${category.key}: ${category.count}`);
  if (digest.threads.length) {
    lines.push("", "Active threads:");
    for (const thread of digest.threads.slice(0, 8)) {
      lines.push(`- ${thread.subject} (${thread.count} messages${thread.unread ? `, ${thread.unread} unread` : ""})`);
    }
  }
  if (digest.messages.length) {
    lines.push("", "Latest messages:");
    for (const message of digest.messages.slice(0, 20)) {
      const sender = message.from?.address ?? "unknown sender";
      lines.push(`- ${message.receivedAt.slice(0, 16).replace("T", " ")} | ${sender} | ${message.subject}`);
    }
  }
  return lines.join("\n");
}

export function formatMailList(digest: MailDigest, limit = 30): string {
  if (!digest.messages.length) return "No mail arrived in this window.";
  return digest.messages.slice(0, limit).map(message => {
    const state = message.isRead ? "read" : "UNREAD";
    const sender = message.from?.address ?? "unknown sender";
    return `${message.receivedAt.slice(0, 16).replace("T", " ")} | ${state} | ${sender} | ${message.subject}`;
  }).join("\n");
}
