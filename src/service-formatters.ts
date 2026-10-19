import type { LibraryFacility, LibraryFacilitiesResult, BookingPlan } from "./library-core.js";
import type { LibraryAvailabilityResult } from "./library.js";
import type { MailMessage, MailMessageSummary } from "./mail-core.js";
import { renderTerminalTable, sanitizeTerminalText } from "./terminal-table.js";

export function formatMailList(messages: readonly MailMessageSummary[]): string {
  if (!messages.length) return "Inbox\n  No matching messages.";
  return [
    "Inbox",
    renderTerminalTable(
      [
        { label: " ", width: 1 },
        { label: "From", width: 26 },
        { label: "Subject", flex: true },
        { label: "Received", width: 16 },
      ],
      messages.map(message => [
        message.unread ? "●" : " ",
        truncate(message.from, 26),
        truncate(message.subject, 72),
        formatMoment(message.received_at),
      ]),
    ),
  ].join("\n");
}

export function formatMailMessage(message: MailMessage): string {
  return [
    `${message.subject}  #${message.uid}`,
    `From: ${message.from}`,
    `To: ${message.to.join(", ") || "(none)"}`,
    message.received_at ? `Received: ${message.received_at}` : "",
    "",
    message.body,
    ...(message.attachments.length
      ? ["", "Attachments:", ...message.attachments.map(item => `  ${item.index} · ${item.name} · ${item.mime_type} · ${item.bytes} bytes`)]
      : []),
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
}

export function formatLibraryFacilities(result: LibraryFacilitiesResult): string {
  if (!result.facilities.length) return "HKU Library spaces\n  No matching facilities.";
  const lines = ["HKU Library spaces"];
  if (result.updated_at) lines.push(`Availability updated ${result.updated_at}`);
  let library = "";
  for (const facility of result.facilities) {
    if (facility.library !== library) {
      if (lines.length > 1) lines.push("");
      library = facility.library;
      lines.push(library);
    }
    lines.push(`  ${truncate(facility.type, 56).padEnd(56)} ${availability(facility)}  ${facility.booking_url}`);
  }
  return lines.join("\n");
}

export function formatBookingPlan(plan: BookingPlan, submitted: boolean, accepted: boolean): string {
  return [
    submitted
      ? accepted ? "Library booking confirmed" : "Library booking submitted"
      : "Library booking plan",
    `${plan.facility || `Facility ${plan.facility_id}`}${plan.floor ? ` · ${plan.floor}` : ""}`,
    `${plan.location || `Library ${plan.library_id}`} · ${plan.facility_type || `Type ${plan.facility_type_id}`}`,
    `${plan.date} · ${plan.start_time}-${plan.end_time}`,
    ...(submitted ? [] : ["Nothing was submitted. Add the command flags from --help to confirm."]),
  ].join("\n");
}

export function formatLibrarySlots(result: LibraryAvailabilityResult): string {
  if (!result.slots.length) {
    return `${result.location} · ${result.facility_type} · ${result.date}\n  No matching available slots.`;
  }
  return [
    `${result.location} · ${result.facility_type} · ${result.date}`,
    renderTerminalTable(
      [
        { label: "Start", width: 5 },
        { label: "End", width: 5 },
        { label: "Floor", width: 8 },
        { label: "Room", flex: true },
      ],
      result.slots.map(slot => [
        slot.start_time,
        slot.end_time,
        slot.floor,
        slot.room,
      ]),
    ),
  ].join("\n");
}

export function formatMailAddresses(values: readonly string[]): string {
  return values.map(value => sanitizeTerminalText(value)).join(", ");
}

function availability(facility: LibraryFacility): string {
  if (facility.available === undefined) return "  ?  ";
  const total = facility.total === undefined ? "" : `/${facility.total}`;
  return `${String(facility.available).padStart(3)}${total}`.padEnd(5);
}

function formatMoment(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function truncate(value: string, width: number): string {
  const clean = sanitizeTerminalText(value).replace(/\s+/gu, " ");
  return clean.length <= width ? clean : `${clean.slice(0, Math.max(0, width - 3))}...`;
}
