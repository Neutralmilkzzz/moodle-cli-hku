import { UsageError } from "./errors.js";
import { facilityById, type FacilityService } from "./facilities.js";

export interface FacilityRequestInput {
  service: string;
  eventDate: string;
  purpose?: string;
  attendees?: number;
  requester?: string;
  contact?: string;
  now?: Date;
}

export interface FacilityRequestPlan {
  service_id: string;
  service: string;
  form_url: string;
  event_date: string;
  earliest_event_date: string;
  latest_submission_date: string;
  eligible: boolean;
  notice: {
    value: number;
    unit: "calendar days" | "working days";
  };
  checklist: string[];
}

export function prepareFacilityRequest(input: FacilityRequestInput): FacilityRequestPlan {
  const service = facilityById(input.service);
  if (!service) throw new UsageError(`Unknown facility service '${input.service}'.`, "Run `hku facilities list`.");
  const form = service.request_form;
  if (!form) {
    throw new UsageError(
      `'${service.name}' is booked through ${service.booking === "integrated" ? "a command workflow" : "its booking portal"}.`,
      service.cli ? `Use \`${service.cli}\`.` : `Run \`hku facilities open ${service.id}\`.`,
    );
  }
  const eventDate = parseDate(input.eventDate);
  const today = hongKongDate(input.now ?? new Date());
  const earliestEvent = addNotice(today, form.minimum_notice_days, form.working_days);
  const latestSubmission = subtractNotice(eventDate, form.minimum_notice_days, form.working_days);
  return {
    service_id: service.id,
    service: service.name,
    form_url: service.url,
    event_date: formatDate(eventDate),
    earliest_event_date: formatDate(earliestEvent),
    latest_submission_date: formatDate(latestSubmission),
    eligible: eventDate.getTime() >= earliestEvent.getTime(),
    notice: {
      value: form.minimum_notice_days,
      unit: form.working_days ? "working days" : "calendar days",
    },
    checklist: requestChecklist(service, input),
  };
}

export function formatFacilityRequest(plan: FacilityRequestPlan): string {
  return [
    `${plan.service}`,
    `Requested event date: ${plan.event_date}`,
    `Minimum notice: ${plan.notice.value} ${plan.notice.unit}`,
    `Earliest bookable event date: ${plan.earliest_event_date}`,
    `Submit no later than: ${plan.latest_submission_date}`,
    plan.eligible
      ? "The requested date meets the published minimum notice."
      : "The requested date does not meet the minimum notice; choose a later date.",
    "",
    "Prepare these details:",
    ...plan.checklist.map(item => `  - ${item}`),
    "",
    `Official form: ${plan.form_url}`,
  ].join("\n");
}

function requestChecklist(service: FacilityService, input: FacilityRequestInput): string[] {
  return [
    `Facility: ${service.name}`,
    `Event date and exact start/end time: ${input.eventDate}`,
    `Purpose or activity: ${input.purpose || "<enter>"}`,
    `Estimated attendance: ${input.attendees ?? "<enter>"}`,
    `Requester name and HKU UID: ${input.requester || "<enter>"}`,
    `Contact number and HKU email: ${input.contact || "<enter>"}`,
    "Equipment, layout, accessibility or technical support requirements",
    "Any faculty/department approval or cost-centre reference if requested",
  ];
}

function addNotice(start: Date, amount: number, workingDays: boolean): Date {
  const date = new Date(start.getTime());
  if (!workingDays) {
    date.setUTCDate(date.getUTCDate() + amount);
    return date;
  }
  let remaining = amount;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (isWeekday(date)) remaining -= 1;
  }
  return date;
}

function subtractNotice(end: Date, amount: number, workingDays: boolean): Date {
  const date = new Date(end.getTime());
  if (!workingDays) {
    date.setUTCDate(date.getUTCDate() - amount);
    return date;
  }
  let remaining = amount;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() - 1);
    if (isWeekday(date)) remaining -= 1;
  }
  return date;
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new UsageError("Facility dates must use YYYY-MM-DD.");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || formatDate(date) !== value) {
    throw new UsageError("Facility date is invalid.");
  }
  return date;
}

function hongKongDate(value: Date): Date {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: string) => Number(parts.find(part => part.type === type)?.value ?? 0);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day")));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isWeekday(date: Date): boolean {
  const day = date.getUTCDay();
  return day !== 0 && day !== 6;
}
