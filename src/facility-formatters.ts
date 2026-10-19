import type { FacilityService } from "./facilities.js";
import type { CseAvailabilityResult, CseBookingResult, CsePortalPage } from "./cse.js";
import type { CseActivity } from "./cse-core.js";
import type { HkufbsAvailabilityResult, HkufbsBookingResult } from "./hkufbs.js";
import type { HkufbsCatalog, HkufbsReservationPlan } from "./hkufbs-core.js";
import { renderTerminalTable, sanitizeTerminalText } from "./terminal-table.js";

export function formatFacilityCatalog(services: readonly FacilityService[]): string {
  if (!services.length) return "No matching HKU facility services.";
  const groups = new Map<string, FacilityService[]>();
  for (const service of services) {
    const list = groups.get(service.category) ?? [];
    list.push(service);
    groups.set(service.category, list);
  }
  return [...groups.entries()].map(([category, items]) => [
    title(category),
    renderTerminalTable(
      [
        { label: "ID", width: 16 },
        { label: "Service", flex: true },
        { label: "Lead time", width: 28 },
        { label: "Mode", width: 10 },
      ],
      items.map(service => [
        service.id,
        service.name,
        truncate(service.lead_time || "See official site", 28),
        service.booking,
      ]),
    ),
  ].join("\n")).join("\n\n");
}

export function formatHkufbsResources(catalog: HkufbsCatalog): string {
  return [
    "HKUFBS bookable resources",
    renderTerminalTable(
      [
        { label: "ID", width: 8 },
        { label: "Resource", flex: true },
      ],
      catalog.resources.map(resource => [resource.id, resource.name]),
    ),
    "CYMAC and FSCAC rooms generally require at least three calendar days' notice.",
  ].join("\n");
}

export function formatCsePortal(page: CsePortalPage): string {
  return [
    `${page.title} · ${page.url}`,
    page.text ? page.text.slice(0, 1_200) : "No readable page text was returned.",
    page.links.length
      ? `Booking links:\n${page.links.map(link => `  ${link.text} · ${link.url}`).join("\n")}`
      : "No booking links were exposed on the landing page.",
  ].join("\n\n");
}

export function formatCseActivities(activities: readonly CseActivity[]): string {
  return [
    "CSE sports activities",
    renderTerminalTable(
      [
        { label: "Activity", flex: true },
        { label: "Code", width: 22 },
        { label: "Individual", width: 10 },
        { label: "Group", width: 7 },
      ],
      activities.map(activity => [
        activity.name,
        activity.code,
        activity.individual ? "yes" : "",
        activity.group ? "yes" : "",
      ]),
    ),
  ].join("\n");
}

export function formatCseSlots(result: CseAvailabilityResult): string {
  if (!result.slots.length) {
    return `CSE availability · ${result.activity} · ${result.date}\nNo matching free slots.`;
  }
  return [
    `CSE availability · ${result.activity} · ${result.date}`,
    renderTerminalTable(
      [
        { label: "Venue", width: 28 },
        { label: "Room", width: 11 },
        { label: "Start", width: 5 },
        { label: "End", width: 5 },
      ],
      result.slots.map(slot => [
        truncate(slot.venue, 28),
        slot.room_code,
        slot.start_time,
        slot.end_time,
      ]),
    ),
  ].join("\n");
}

export function formatCseBooking(result: CseBookingResult): string {
  const lines = [
    "CSE reservation preview",
    `${result.plan.activity} · ${result.plan.venue}`,
    `${result.plan.date} · ${result.plan.start_time}-${result.plan.end_time}`,
    `${result.plan.room} (${result.plan.room_code})`,
    ...result.plan.warnings,
  ];
  if (!result.submitted) lines.push("Dry run: nothing was submitted to CSE.");
  else lines.push(result.message || (result.success ? "CSE accepted the booking." : "CSE did not confirm the booking."));
  return lines.join("\n\n");
}

export function formatHkufbsSlots(result: HkufbsAvailabilityResult): string {
  if (!result.openings.length) {
    return `HKUFBS availability · ${result.date}${result.end_date !== result.date ? ` to ${result.end_date}` : ""}\nNo matching openings.`;
  }
  return [
    `HKUFBS availability · ${result.date}${result.end_date !== result.date ? ` to ${result.end_date}` : ""}`,
    renderTerminalTable(
      [
        { label: "Resource ID", width: 11 },
        { label: "Resource", flex: true },
        { label: "Date", width: 10 },
        { label: "Start", width: 5 },
        { label: "End", width: 5 },
      ],
      result.openings.map(opening => [
        opening.resource_id,
        opening.resource,
        opening.date,
        opening.start_time,
        opening.end_time,
      ]),
    ),
  ].join("\n");
}

export function formatHkufbsBooking(result: HkufbsBookingResult): string {
  const lines = [formatHkufbsPlan(result.plan)];
  if (!result.submitted) {
    lines.push("Dry run: nothing was submitted to HKUFBS.");
    return lines.join("\n\n");
  }
  if (result.success) {
    lines.push(`HKUFBS accepted the reservation${result.reference_number ? ` · ${result.reference_number}` : ""}.`);
    if (result.requires_approval) lines.push("The reservation requires approval.");
  } else {
    lines.push(`HKUFBS did not save the reservation${result.errors.length ? `: ${result.errors.join("; ")}` : "."}`);
  }
  return lines.join("\n\n");
}

export function formatHkufbsPlan(plan: HkufbsReservationPlan): string {
  return [
    "HKUFBS reservation preview",
    `${plan.resource} (${plan.resource_id})`,
    `${plan.date} · ${plan.start}-${plan.end} (Asia/Hong_Kong)`,
    ...(plan.minimum_notice_minutes !== undefined
      ? [`Advance notice: ${plan.minimum_notice_minutes} minutes`]
      : []),
    ...(plan.min_duration_minutes !== undefined && plan.max_duration_minutes !== undefined
      ? [`Allowed duration: ${plan.min_duration_minutes}-${plan.max_duration_minutes} minutes`]
      : []),
    ...(plan.required_attributes.length
      ? [`Required details: ${plan.required_attributes.map(attribute => attribute.label).join(", ")}`]
      : []),
    ...plan.warnings,
  ].join("\n");
}

function title(category: string): string {
  const names: Record<string, string> = {
    library: "Library and learning spaces",
    sports: "Sports facilities",
    campus: "Campus and life facilities",
    forms: "Application forms",
  };
  return names[category] || category;
}

function truncate(value: string, width: number): string {
  const clean = sanitizeTerminalText(value).replace(/\s+/gu, " ");
  return clean.length <= width ? clean : `${clean.slice(0, width - 3)}...`;
}
