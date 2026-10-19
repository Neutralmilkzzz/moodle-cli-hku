import { parse, type HTMLElement } from "node-html-parser";

export interface HkufbsSchedule {
  id: string;
  name: string;
}

export interface HkufbsResource {
  id: string;
  name: string;
  schedule_id?: string;
}

export interface HkufbsCatalog {
  action: string;
  csrf_token: string;
  schedules: HkufbsSchedule[];
  resources: HkufbsResource[];
}

export interface HkufbsOpening {
  resource_id: string;
  resource: string;
  date: string;
  start: string;
  end: string;
  start_time: string;
  end_time: string;
  reservation_url: string;
}

export interface HkufbsSearchQuery {
  date: string;
  endDate?: string;
  resource?: string;
  durationMinutes?: number;
  start?: string;
  end?: string;
}

export interface HkufbsAttribute {
  id: number;
  label: string;
  required: boolean;
  type?: number;
  possible_values?: string[];
  regex?: string;
}

export interface HkufbsReservationPlan {
  service: "hkufbs";
  resource_id: string;
  resource: string;
  date: string;
  start: string;
  end: string;
  start_iso: string;
  end_iso: string;
  owner_id: number;
  title?: string;
  requires_approval?: boolean;
  minimum_notice_minutes?: number;
  min_duration_minutes?: number;
  max_duration_minutes?: number;
  required_attributes: Array<{ id: number; label: string; type?: number; possible_values?: string[] }>;
  warnings: string[];
  reservation_url: string;
}

export interface HkufbsResourceRules {
  id: string;
  name: string;
  notice_add_minutes: number;
  min_duration_minutes: number;
  max_duration_minutes: number;
  requires_approval: boolean;
  notes?: string;
}

export function parseHkufbsCatalog(html: string, pageUrl: string): HkufbsCatalog {
  const root = parse(html);
  const form = root.querySelectorAll("form").find(candidate =>
    Boolean(candidate.querySelector('[name="resourceId[]"]')));
  const csrf = root.querySelector('input[name="CSRF_TOKEN"]')?.getAttribute("value")?.trim() ?? "";
  if (!form || !csrf) {
    throw new Error("HKUFBS returned an unexpected availability page. Sign in again and retry.");
  }
  const selectedResources = selectOptions(root, "#resourceGroups").map(option => ({ id: option.value, name: option.label }));
  return {
    action: new URL(form.getAttribute("action") || pageUrl, pageUrl).toString(),
    csrf_token: csrf,
    schedules: selectOptions(root, "#schedules").map(option => ({ id: option.value, name: option.label })),
    resources: selectedResources.length ? selectedResources : embeddedResources(root),
  };
}

export function parseHkufbsOpenings(html: string, pageUrl: string, catalog?: Pick<HkufbsCatalog, "resources">): HkufbsOpening[] {
  const root = parse(html);
  const names = new Map((catalog?.resources ?? []).map(resource => [resource.id, resource.name]));
  const openings = root.querySelectorAll(".opening").flatMap(node => {
    const resourceId = node.getAttribute("data-resourceid")?.trim() ?? "";
    const start = node.getAttribute("data-startdate")?.trim() ?? "";
    const end = node.getAttribute("data-enddate")?.trim() ?? "";
    if (!resourceId || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(start)
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(end)) return [];
    const resource = cleanText(node.querySelector(".resourceName")?.textContent) || names.get(resourceId) || `Resource ${resourceId}`;
    return [{
      resource_id: resourceId,
      resource,
      date: start.slice(0, 10),
      start,
      end,
      start_time: start.slice(11, 16),
      end_time: end.slice(11, 16),
      reservation_url: reservationUrl(pageUrl, resourceId, start, end),
    }];
  });
  return [...new Map(openings.map(opening => [
    `${opening.resource_id}\0${opening.start}\0${opening.end}`,
    opening,
  ])).values()];
}

export function buildHkufbsSearchBody(
  catalog: HkufbsCatalog,
  query: HkufbsSearchQuery,
): URLSearchParams {
  const resources = resolveResources(catalog, query.resource);
  const exactRange = Boolean(query.start || query.end);
  if (exactRange && (!query.start || !query.end)) {
    throw new Error("HKUFBS specific-time search requires both a start and end time.");
  }
  const duration = exactRange
    ? minutesBetween(query.start!, query.end!)
    : query.durationMinutes ?? 30;
  if (!Number.isInteger(duration) || duration < 30 || duration > 12 * 60) {
    throw new Error("HKUFBS duration must be an integer from 30 to 720 minutes.");
  }
  const body = new URLSearchParams();
  append(body, "scheduleId", "0");
  for (const resource of resources) append(body, "resourceId[]", resource.id);
  append(body, "AVAILABILITY_SEARCH_TYPE", "1");
  append(body, "HOURS", String(Math.floor(duration / 60)));
  append(body, "MINUTES", String(duration % 60));
  append(body, "beginTime", hkufbsTime(query.start ?? "09:00"));
  append(body, "endTime", hkufbsTime(query.end ?? "21:00"));
  append(body, "AVAILABILITY_RANGE", "daterange");
  append(body, "beginDate", query.date);
  append(body, "endDate", query.endDate ?? query.date);
  append(body, "ANY_TIME", "on");
  append(body, "repeatOptions", "none");
  append(body, "repeatEvery", "1");
  append(body, "repeatMonthlyType", "dayOfMonth");
  append(body, "maxParticipants", "");
  append(body, "RESOURCE_TYPE_ID", "");
  append(body, "CSRF_TOKEN", catalog.csrf_token);
  append(body, "SUBMIT", "submit");
  return body;
}

export function resolveHkufbsResource(
  catalog: Pick<HkufbsCatalog, "resources">,
  wanted: string,
): HkufbsResource {
  const resolved = resolveResources(catalog, wanted);
  if (resolved.length !== 1) {
    throw new Error(`HKUFBS resource '${wanted}' matched more than one room. Use the numeric resource id.`);
  }
  return resolved[0]!;
}

export function hongKongIso(date: string, time: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !/^\d{2}:\d{2}$/u.test(time)) {
    throw new Error("HKUFBS date and time must use YYYY-MM-DD and HH:mm.");
  }
  return new Date(`${date}T${time}:00+08:00`).toISOString();
}

export function parseHkufbsAttributes(payload: unknown): HkufbsAttribute[] {
  const data = asRecord(asRecord(payload).data);
  const attributes = Array.isArray(data.attributes) ? data.attributes : [];
  return attributes.flatMap(item => {
    const value = asRecord(item);
    if (typeof value.id !== "number" || typeof value.label !== "string") return [];
    return [{
      id: value.id,
      label: value.label,
      required: value.required === true,
      ...(typeof value.type === "number" ? { type: value.type } : {}),
      ...(Array.isArray(value.possibleValues)
        ? { possible_values: value.possibleValues.flatMap(option => typeof option === "string" ? [option] : []) }
        : {}),
      ...(typeof value.regex === "string" ? { regex: value.regex } : {}),
    }];
  });
}

export function parseHkufbsReservationPage(html: string): {
  csrf_token: string;
  owner_id: number;
  logged_in: boolean;
} {
  const csrf = /const\s+csrf\s*=\s*["']([^"']+)["']/u.exec(html)?.[1]
    ?? /name=["']CSRF_TOKEN["'][^>]*value=["']([^"']+)["']/iu.exec(html)?.[1]
    ?? "";
  const owner = Number(/const\s+userId\s*=\s*(\d+)/u.exec(html)?.[1] ?? 0);
  const loggedIn = /const\s+loggedIn\s*=\s*true/u.test(html);
  if (!csrf || !owner || !loggedIn) {
    throw new Error("HKUFBS did not present a signed-in reservation form. Run `hku facilities hkufbs login`.");
  }
  return { csrf_token: csrf, owner_id: owner, logged_in: loggedIn };
}

export function parseHkufbsResourceRules(payload: unknown, resourceId: string): HkufbsResourceRules {
  const data = asRecord(asRecord(payload).data);
  const resources = Array.isArray(data.resources) ? data.resources : [];
  const resource = resources
    .map(asRecord)
    .find(item => String(item.id ?? "") === resourceId);
  if (!resource) {
    throw new Error("HKUFBS did not include the selected resource in its reservation data.");
  }
  return {
    id: String(resource.id),
    name: cleanText(typeof resource.name === "string" ? resource.name : ""),
    notice_add_minutes: durationMinutes(resource.noticeAdd),
    min_duration_minutes: durationMinutes(resource.minDuration),
    max_duration_minutes: durationMinutes(resource.maxDuration),
    requires_approval: resource.requiresApproval === true,
    ...(typeof resource.notes === "string" && resource.notes.trim() ? { notes: resource.notes.trim() } : {}),
  };
}

export function parseHkufbsSaveReceipt(payload: unknown): {
  success: boolean;
  reference_number?: string;
  requires_approval?: boolean;
  errors: string[];
} {
  const data = asRecord(asRecord(payload).data);
  const rawErrors = Array.isArray(data.errors) ? data.errors : [];
  return {
    success: data.success === true,
    ...(typeof data.referenceNumber === "string" ? { reference_number: data.referenceNumber } : {}),
    ...(typeof data.requiresApproval === "boolean" ? { requires_approval: data.requiresApproval } : {}),
    errors: rawErrors.flatMap(item => {
      if (typeof item === "string") return [item];
      const record = asRecord(item);
      return [typeof record.errorMessage === "string"
        ? record.errorMessage
        : typeof record.message === "string" ? record.message : JSON.stringify(item)];
    }),
  };
}

function resolveResources(catalog: Pick<HkufbsCatalog, "resources">, wanted?: string): HkufbsResource[] {
  if (!wanted) return [...catalog.resources];
  const normalized = wanted.trim().toLowerCase();
  const comparable = normalized.replace(/[^a-z0-9]+/gu, "");
  const matches = catalog.resources.filter(resource =>
    resource.id === normalized
    || resource.name.trim().toLowerCase() === normalized
    || resource.name.toLowerCase().replace(/[^a-z0-9]+/gu, "") === comparable);
  if (!matches.length) {
    throw new Error(`HKUFBS resource '${wanted}' was not found. Run \`hku facilities hkufbs resources\`.`);
  }
  return matches;
}

function selectOptions(root: HTMLElement, selector: string): Array<{ value: string; label: string }> {
  const select = root.querySelector(selector);
  return (select?.querySelectorAll("option") ?? []).flatMap(option => {
    const value = option.getAttribute("value")?.trim() ?? "";
    const label = cleanText(option.textContent);
    return value && label ? [{ value, label }] : [];
  });
}

function embeddedResources(root: HTMLElement): HkufbsResource[] {
  const script = root.querySelectorAll("script:not([src])").map(node => node.textContent).join("\n");
  const start = script.indexOf("const allResources = ");
  if (start < 0) return [];
  const end = script.indexOf("];", start);
  if (end < 0) return [];
  const source = script.slice(start, end + 2);
  const resources: HkufbsResource[] = [];
  for (const match of source.matchAll(/id['"]?\s*:\s*(\d+)[\s\S]*?text['"]?\s*:\s*['"]([^'"]+)['"][\s\S]*?scheduleId['"]?\s*:\s*(\d+)/gu)) {
    resources.push({
      id: match[1]!,
      name: cleanText(match[2]),
      schedule_id: match[3]!,
    });
  }
  return [...new Map(resources.map(resource => [resource.id, resource])).values()];
}

function reservationUrl(pageUrl: string, resourceId: string, start: string, end: string): string {
  const url = new URL("reservation/", pageUrl);
  url.searchParams.set("rid", resourceId);
  url.searchParams.set("sd", start);
  url.searchParams.set("ed", end);
  return url.toString();
}

function hkufbsTime(value: string): string {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new Error("HKUFBS time must use HH:mm.");
  const hour = Number(match[1]);
  if (hour > 23 || Number(match[2]) > 59) throw new Error("HKUFBS time is invalid.");
  const suffix = hour < 12 ? "AM" : "PM";
  const display = hour % 12 || 12;
  return `${display}:${match[2]} ${suffix}`;
}

function minutesBetween(start: string, end: string): number {
  if (!/^\d{2}:\d{2}$/u.test(start) || !/^\d{2}:\d{2}$/u.test(end)) {
    throw new Error("HKUFBS time must use HH:mm.");
  }
  const [startHour, startMinute] = start.split(":").map(Number) as [number, number];
  const [endHour, endMinute] = end.split(":").map(Number) as [number, number];
  return (endHour * 60 + endMinute) - (startHour * 60 + startMinute);
}

function durationMinutes(value: unknown): number {
  const duration = asRecord(value);
  return (Number(duration.days ?? 0) * 24 * 60)
    + (Number(duration.hours ?? 0) * 60)
    + Number(duration.minutes ?? 0);
}

function append(body: URLSearchParams, name: string, value: string): void {
  body.append(name, value);
}

function cleanText(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
