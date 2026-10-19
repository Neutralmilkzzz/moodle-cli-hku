import { parse, type HTMLElement } from "node-html-parser";

import { NotFoundError, UsageError } from "./errors.js";

export const HKU_LIBRARY_PUBLIC_URL = "https://lib.hku.hk/general/e-form/book-a-space.html";
export const HKU_LIBRARY_BOOKING_ORIGIN = "https://booking.lib.hku.hk";

export interface LibraryFacility {
  library: string;
  type: string;
  available?: number;
  total?: number;
  booking_url: string;
  source_id?: string;
}

export interface LibraryFacilitiesResult {
  updated_at?: string;
  facilities: LibraryFacility[];
  source_url: string;
}

export interface BookingUrlTarget {
  url: string;
  library_id: string;
  facility_type_id: string;
  facility_id: string;
  date: string;
  session_index: number;
}

export interface BookingPlan extends BookingUrlTarget {
  location?: string;
  floor?: string;
  facility_type?: string;
  facility?: string;
  start_time: string;
  end_time: string;
  marked: boolean;
}

export interface LibraryAvailableSlot {
  floor: string;
  room: string;
  date?: string;
  start_time: string;
  end_time: string;
  booking_url: string;
}

export interface LibraryAvailabilityPage {
  page: number;
  page_count: number;
  selected: {
    location?: string;
    facility_type?: string;
    date?: string;
  };
  slots: LibraryAvailableSlot[];
}

export interface LibraryBookingRecord {
  date?: string;
  time?: string;
  start?: string;
  end?: string;
  location?: string;
  floor?: string;
  facility?: string;
  status?: string;
}

export interface LibraryBookingCancelTarget {
  index: number;
  record: LibraryBookingRecord;
  cancel_control: string;
}

export interface BookingFormPlan {
  form: ParsedHtmlForm;
  plan: BookingPlan;
}

export interface ParsedHtmlSelectOption {
  value: string;
  label: string;
  selected: boolean;
  disabled: boolean;
}

export interface ParsedHtmlControl {
  tag: string;
  type: string;
  name: string;
  id: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  options: ParsedHtmlSelectOption[];
  label: string;
}

export interface ParsedHtmlForm {
  action: string;
  method: string;
  controls: ParsedHtmlControl[];
}

export interface BookingSubmission {
  values: Record<string, string>;
  plan: BookingPlan;
}

export function parseLibraryFacilities(
  pageHtml: string,
  availabilityHtml = "",
  sourceUrl = HKU_LIBRARY_PUBLIC_URL,
): LibraryFacilitiesResult {
  const root = parse(pageHtml);
  const counts = parseAvailabilityCounts(availabilityHtml);
  const facilities: LibraryFacility[] = [];
  let library = "";
  for (const row of root.querySelectorAll("tr")) {
    const className = row.getAttribute("class") || "";
    if (className.split(/\s+/u).includes("trLibName")) {
      library = text(row);
      continue;
    }
    if (!className.split(/\s+/u).includes("trLibItem") || !library) continue;
    const link = row.querySelectorAll("a").find(node => /booking\.lib\.hku\.hk|lib\.hku\.hk/iu.test(node.getAttribute("href") || ""));
    if (!link) continue;
    const href = link.getAttribute("href") || "";
    const type = text(link);
    const availability = row.querySelector(".textavail");
    const total = row.querySelector(".texttotal");
    const sourceId = availability?.getAttribute("id")?.replace(/[AT]$/u, "");
    const live = sourceId ? counts[sourceId] : undefined;
    const available = live?.available ?? parseCount(availability ? text(availability) : undefined);
    const totalCount = live?.total ?? parseCount(total ? text(total) : undefined);
    const bookingUrl = safeHttpsUrl(href, sourceUrl);
    if (!bookingUrl) continue;
    facilities.push({
      library,
      type,
      ...(available === undefined ? {} : { available }),
      ...(totalCount === undefined ? {} : { total: totalCount }),
      booking_url: bookingUrl,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
  }

  const updatedAt = parse(availabilityHtml).querySelector("#Time")?.textContent?.trim()
    || root.querySelector("#Time")?.textContent?.trim()
    || undefined;
  return { ...(updatedAt ? { updated_at: updatedAt } : {}), facilities, source_url: sourceUrl };
}

export function filterLibraryFacilities(
  result: LibraryFacilitiesResult,
  options: { library?: string; type?: string; availableOnly?: boolean } = {},
): LibraryFacilitiesResult {
  const library = options.library?.trim().toLowerCase();
  const type = options.type?.trim().toLowerCase();
  const facilities = result.facilities.filter(item =>
    (!library || item.library.toLowerCase().includes(library))
    && (!type || item.type.toLowerCase().includes(type))
    && (!options.availableOnly || (item.available ?? 0) > 0));
  return { ...result, facilities };
}

export function parseBookingUrl(raw: string): BookingUrlTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("Booking URL is not a valid URL.");
  }
  if (url.origin !== HKU_LIBRARY_BOOKING_ORIGIN || !/^\/Secure\/NewBooking\.aspx$/iu.test(url.pathname)) {
    throw new UsageError(
      "Booking URL must be an HKUL NewBooking.aspx link.",
      "Run `hku library facilities` and open the facility page to choose an available slot.",
    );
  }
  const libraryId = positiveId(url.searchParams.get("library"), "library");
  const facilityTypeId = positiveId(url.searchParams.get("ftype"), "facility type");
  const facilityId = positiveId(url.searchParams.get("facility"), "facility");
  const rawDate = url.searchParams.get("date") || "";
  if (!/^\d{8}$/u.test(rawDate)) throw new UsageError("Booking URL must include date=YYYYMMDD.");
  const session = Number(url.searchParams.get("session"));
  if (!Number.isInteger(session) || session < 0) throw new UsageError("Booking URL must include a non-negative session index.");
  return {
    url: url.toString(),
    library_id: libraryId,
    facility_type_id: facilityTypeId,
    facility_id: facilityId,
    date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
    session_index: session,
  };
}

export function parseLibraryAvailabilityPage(
  html: string,
  pageUrl: string,
): LibraryAvailabilityPage {
  const root = parse(html);
  const form = parseHtmlForm(html);
  const fields = form.controls.filter(control => control.tag === "select");
  const selectedControl = (pattern: RegExp) => {
    const control = fields.find(item => pattern.test(`${item.id} ${item.name}`.toLowerCase()));
    return control ? control.options.find(option => option.selected)?.label : undefined;
  };
  const pageControl = fields.find(control =>
    control.options.length > 0 && control.options.every(option => /^\d+$/u.test(option.label.trim())));
  const page = Number(pageControl?.value || 1);
  const pageCount = Math.max(1, pageControl?.options.length || 1);
  const selectedDateText = selectedControl(/ddlview|date/u);
  const slots: LibraryAvailableSlot[] = [];

  for (const table of root.querySelectorAll("table[id]")) {
    if (!/^main_\d+$/u.test(table.getAttribute("id") || "")) continue;
    const rows = table.querySelectorAll("tr");
    if (!rows.length) continue;
    const headers = rows[0].querySelectorAll("th, td").map(cell => normalizedText(cell.textContent));
    for (const row of rows.slice(1)) {
      const cells = row.querySelectorAll("td");
      if (cells.length < 3) continue;
      const floor = normalizedText(cells[0].textContent);
      const room = normalizedText(cells[1].textContent);
      if (!floor || !room) continue;
      for (let index = 2; index < cells.length; index += 1) {
        const range = timeRange(headers[index] || "");
        if (!range) continue;
        for (const link of cells[index].querySelectorAll("a")) {
          if (!/^select$/iu.test(normalizedText(link.textContent))) continue;
          const href = link.getAttribute("href") || "";
          const bookingUrl = safeHttpsUrl(href, pageUrl);
          if (!bookingUrl) continue;
          slots.push({
            floor,
            room,
            ...(selectedDateText?.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0]
              ? { date: selectedDateText.match(/\b\d{4}-\d{2}-\d{2}\b/u)![0] }
              : {}),
            start_time: range.start,
            end_time: range.end,
            booking_url: bookingUrl,
          });
        }
      }
    }
  }

  const deduped = [...new Map(slots.map(slot => [
    `${slot.floor}\0${slot.room}\0${slot.start_time}\0${slot.end_time}`,
    slot,
  ])).values()];
  return {
    page: Number.isInteger(page) && page > 0 ? page : 1,
    page_count: pageCount,
    selected: {
      ...(selectedControl(/ddllibrary|location/u) ? { location: selectedControl(/ddllibrary|location/u)! } : {}),
      ...(selectedControl(/ddltype|facility.*type/u) ? { facility_type: selectedControl(/ddltype|facility.*type/u)! } : {}),
      ...(selectedDateText ? { date: selectedDateText } : {}),
    },
    slots: deduped,
  };
}

export function buildBookingUrl(input: {
  libraryId: string;
  facilityTypeId: string;
  facilityId: string;
  date: string;
  sessionIndex: number;
}): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.date)) throw new UsageError("Date must use YYYY-MM-DD.");
  if (!Number.isInteger(input.sessionIndex) || input.sessionIndex < 0) throw new UsageError("Session index must be non-negative.");
  const url = new URL("/Secure/NewBooking.aspx", HKU_LIBRARY_BOOKING_ORIGIN);
  url.searchParams.set("library", positiveId(input.libraryId, "library"));
  url.searchParams.set("ftype", positiveId(input.facilityTypeId, "facility type"));
  url.searchParams.set("facility", positiveId(input.facilityId, "facility"));
  url.searchParams.set("date", input.date.replaceAll("-", ""));
  url.searchParams.set("session", String(input.sessionIndex));
  return url.toString();
}

/**
 * Read the exact target from ASP.NET's booking form. The official NewBooking
 * URL already carries the target; the form's selected session and date are
 * checked so a stale or altered link cannot produce a booking for another slot.
 */
export function parseBookingForm(
  html: string,
  target: BookingUrlTarget,
  expected: { startTime?: string; endTime?: string } = {},
): BookingFormPlan {
  const form = parseHtmlForm(html);
  const body = normalizedText(parse(html).textContent);
  if (!/\bnew booking\b/iu.test(body)) {
    throw new UsageError(
      "The authenticated HKUL New Booking form is not loaded.",
      "Run `hku library login`, then retry the official booking link.",
    );
  }

  const sessions = form.controls
    .filter(control => control.type === "checkbox" && /listSession/iu.test(control.name))
    .map(control => ({ control, range: timeRange(control.label || control.value) }))
    .filter((item): item is { control: ParsedHtmlControl; range: TimeRange } => Boolean(item.range));
  if (!sessions.length) {
    throw new UsageError("The HKUL booking form did not expose any selectable sessions.");
  }

  const wantedStart = expected.startTime || undefined;
  const wantedEnd = expected.endTime || undefined;
  let exact = sessions.filter(item =>
    (!wantedStart || item.range.start === wantedStart)
    && (!wantedEnd || item.range.end === wantedEnd));
  if (!wantedStart && !wantedEnd) {
    if (exact.length !== 1) {
      throw new UsageError(
        `The booking form marks ${exact.length} sessions. Pass --start HH:mm and --end HH:mm to choose one exact session.`,
      );
    }
  } else if (exact.length !== 1) {
    throw new UsageError("The requested session is not uniquely present on the HKUL booking form.");
  }
  const selected = exact[0];
  const selectedOptions = selectedControlLabels(form);
  const date = selectedOptions.date?.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0];
  if (date && date !== target.date) {
    throw new UsageError(`The HKUL form is for ${date}, not ${target.date}.`);
  }

  return {
    form,
    plan: {
      ...target,
      ...(selectedOptions.location ? { location: selectedOptions.location } : {}),
      ...(selectedOptions.floor ? { floor: selectedOptions.floor } : {}),
      ...(selectedOptions.facility_type ? { facility_type: selectedOptions.facility_type } : {}),
      ...(selectedOptions.facility ? { facility: selectedOptions.facility } : {}),
      start_time: selected.range.start,
      end_time: selected.range.end,
      marked: selected.control.checked,
    },
  };
}

export function buildBookingSubmission(
  formPlan: BookingFormPlan,
  options: { description?: string; email?: string } = {},
): BookingSubmission {
  const session = findExactSessionControl(formPlan.form, formPlan.plan.start_time, formPlan.plan.end_time);
  const values = serializeHtmlForm(formPlan.form);
  for (const key of Object.keys(values)) {
    if (key.includes("listSession")) delete values[key];
  }
  values[session.name] = session.value || `${formPlan.plan.start_time.replace(":", "")}${formPlan.plan.end_time.replace(":", "")}`;
  values["ctl00$main$txtUserDescription"] ??= options.description || "";
  values["ctl00$main$txtEmail"] ??= options.email || "";
  values["ctl00$main$hBtnSubmit"] ??= "";
  values["ctl00$main$hBtnEmail"] ??= "";
  values["ctl00$main$hBtnResult"] ??= "";
  values["ctl00$main$btnSubmit"] = "Submit";
  delete values["ctl00$main$ToolkitScriptManager1"];
  delete values.__ASYNCPOST;
  values.__EVENTTARGET ??= "";
  values.__EVENTARGUMENT ??= "";
  values.__LASTFOCUS ??= "";
  return { values, plan: formPlan.plan };
}

export function buildBookingConfirmationSubmission(
  submitted: Record<string, string>,
  confirmationHtml = "",
): { values: Record<string, string>; yes: ParsedHtmlControl } {
  const fragment = parseHtmlForm(confirmationHtml, true);
  const yes = fragment.controls.find(control =>
    control.id === "main_btnSubmitYes"
    && control.type === "submit"
    && /^yes$/iu.test(control.value));
  if (!yes) {
    throw new UsageError("HKUL did not return the expected final confirmation control.");
  }
  const updated = {
    ...submitted,
    ...serializeHtmlForm(fragment),
    [yes.name || "ctl00$main$btnSubmitYes"]: "Yes",
  };
  delete updated["ctl00$main$ToolkitScriptManager1"];
  delete updated.__ASYNCPOST;
  return { values: updated, yes };
}

export function confirmationMatches(
  html: string,
  plan: BookingPlan,
): boolean {
  const text = normalizedText(parse(html).textContent);
  if (!/please confirm the following booking/iu.test(text)) return false;
  const expected = [
    plan.facility_type,
    plan.facility,
    plan.date,
    `${plan.start_time} - ${plan.end_time}`,
  ].filter((value): value is string => Boolean(value));
  return expected.every(value => text.toLowerCase().includes(normalizedText(value).toLowerCase()));
}

export function bookingWasAccepted(html: string): boolean {
  return /your booking is successful|booking (?:was|is) successful|booking confirmed/iu.test(normalizedText(parse(html).textContent));
}

export function parseBookingRecords(html: string): LibraryBookingRecord[] {
  return parseBookingCancelTargets(html).map(target => target.record);
}

export function parseBookingCancelTargets(html: string): LibraryBookingCancelTarget[] {
  const root = parse(html);
  const table = root.querySelector("#main_gvRecord");
  if (!table) throw new NotFoundError("The HKUL booking record table was not found.");
  const rows = table.querySelectorAll("tr");
  const targets: LibraryBookingCancelTarget[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const cells = row.querySelectorAll("td").map(text);
    if (cells.length < 7) continue;
    const startText = cells[1] || "";
    const endText = cells[2] || "";
    const date = startText.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0]
      || endText.match(/\b\d{4}-\d{2}-\d{2}\b/u)?.[0];
    const start = startText.match(/\b\d{2}:\d{2}\b/u)?.[0];
    const end = endText.match(/\b\d{2}:\d{2}\b/u)?.[0];
    const cancel = row.querySelector('input[type="image"][title="Cancel Booking"]');
    targets.push({
      index,
      record: {
        ...(date ? { date } : {}),
        ...(start && end ? { time: `${start} - ${end}` } : {}),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(cells[3] ? { location: cells[3] } : {}),
        ...(cells[4] ? { floor: cells[4] } : {}),
        ...(cells[5] ? { facility: cells[5] } : {}),
        ...(cells[6] ? { status: cells[6] } : {}),
      },
      cancel_control: cancel?.getAttribute("name") || "",
    });
  }
  return targets;
}

export function buildCancellationRequest(
  html: string,
  target: LibraryBookingCancelTarget,
): Record<string, string> {
  if (!target.cancel_control) {
    throw new UsageError("The selected HKUL booking has no cancellation control.");
  }
  const form = parseHtmlForm(html);
  return serializeHtmlForm(form, {
    [`${target.cancel_control}.x`]: "0",
    [`${target.cancel_control}.y`]: "0",
  });
}

export function cancellationMatches(html: string, record: LibraryBookingRecord): boolean {
  const value = parse(html).textContent.replace(/\s+/gu, " ").trim().toLowerCase();
  if (!/are you sure to cancel the following booking/iu.test(value)) return false;
  const expected = [
    record.start,
    record.end,
    record.location,
    record.floor,
    record.facility,
  ].filter((item): item is string => Boolean(item));
  return expected.every(item => value.includes(item.toLowerCase()));
}

export function serializeHtmlForm(form: ParsedHtmlForm, overrides: Record<string, string> = {}): Record<string, string> {
  const values: Record<string, string> = {};
  for (const control of form.controls) {
    if (!control.name || control.disabled) continue;
    if (["button", "submit", "reset", "image", "file"].includes(control.type)) continue;
    if (["checkbox", "radio"].includes(control.type)) {
      if (control.checked) values[control.name] = control.value || "on";
      continue;
    }
    if (control.tag === "select") {
      const selected = control.options.find(option => option.selected && !option.disabled) ?? control.options.find(option => !option.disabled);
      if (selected) values[control.name] = selected.value;
      continue;
    }
    if (control.tag === "textarea") {
      values[control.name] = control.value;
      continue;
    }
    values[control.name] = control.value;
  }
  return { ...values, ...overrides };
}

export function parseHtmlForm(html: string, allowFragment = false): ParsedHtmlForm {
  const root = parse(html);
  const form = root.querySelector("form");
  if (!form && !allowFragment) throw new UsageError("The HKUL page did not contain a form.");
  const scope: HTMLElement = form ?? root;
  const labels = new Map<string, string>();
  for (const label of scope.querySelectorAll("label")) {
    const target = label.getAttribute("for") || "";
    if (target) labels.set(target, text(label));
  }
  const controls = scope.querySelectorAll("input, select, textarea").flatMap(node => {
    const tag = node.tagName?.toLowerCase() || "";
    const name = node.getAttribute("name") || "";
    const id = node.getAttribute("id") || "";
    const rawType = node.getAttribute("type") || (tag === "select" ? "select-one" : tag === "textarea" ? "textarea" : "text");
    const type = rawType.toLowerCase();
    const options = tag === "select"
      ? node.querySelectorAll("option").map(option => ({
          value: option.getAttribute("value") ?? option.textContent,
          label: text(option),
          selected: option.hasAttribute("selected"),
          disabled: option.hasAttribute("disabled"),
        }))
      : [];
    const rowText = text(node.closest("tr") ?? node.parentNode as HTMLElement);
    return [{
      tag,
      type,
      name,
      id,
      value: tag === "select"
        ? (options.find(option => option.selected)?.value ?? options[0]?.value ?? "")
        : tag === "textarea" ? node.textContent : (node.getAttribute("value") ?? ""),
      checked: node.hasAttribute("checked"),
      disabled: node.hasAttribute("disabled"),
      options,
      label: labels.get(id) || rowText,
    }];
  });
  return {
    action: form?.getAttribute("action") || "",
    method: (form?.getAttribute("method") || "post").toLowerCase(),
    controls,
  };
}

function parseAvailabilityCounts(html: string): Record<string, { available: number; total: number }> {
  const root = parse(html);
  const counts: Record<string, { available: number; total: number }> = {};
  for (const node of root.querySelectorAll("[id]")) {
    const match = /^(.+)_Cnt([AT])$/u.exec(node.getAttribute("id") || "");
    if (!match) continue;
    const value = Number(text(node));
    if (!Number.isFinite(value)) continue;
    const target = counts[match[1]] ?? { available: 0, total: 0 };
    if (match[2] === "A") target.available = value;
    else target.total = value;
    counts[match[1]] = target;
  }
  return counts;
}

function selectedControlLabels(form: ParsedHtmlForm): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const control of form.controls.filter(item => item.tag === "select")) {
    const selected = control.options.find(option => option.selected) ?? control.options[0];
    const descriptor = `${control.name} ${control.id}`.toLowerCase();
    if (/ddllibrary|location/u.test(descriptor)) labels.location = selected?.label || "";
    else if (/ddlfloor|floor/u.test(descriptor)) labels.floor = selected?.label || "";
    else if (/ddltype|facility.*type|type.*facility/u.test(descriptor)) labels.facility_type = selected?.label || "";
    else if (/ddlfacility|facility/u.test(descriptor)) labels.facility = selected?.label || "";
    else if (/ddldate|date/u.test(descriptor)) labels.date = selected?.label || "";
  }
  return labels;
}

function findExactSessionControl(form: ParsedHtmlForm, start: string, end: string): ParsedHtmlControl {
  const matches = form.controls.filter(control =>
    control.type === "checkbox"
    && /listSession/iu.test(control.name)
    && timeMatches(control.label || control.value, start, end)
    && !control.disabled);
  if (matches.length !== 1) {
    throw new UsageError("The exact HKUL booking session was not uniquely selectable.");
  }
  return matches[0];
}

interface TimeRange {
  start: string;
  end: string;
}

function timeRange(value: string): TimeRange | null {
  const match = normalizedText(value).match(/\b([01]?\d|2[0-3]):([0-5]\d)\s*(?:-|–|—|to)\s*([01]?\d|2[0-3]):([0-5]\d)\b/iu);
  return match
    ? { start: `${match[1].padStart(2, "0")}:${match[2]}`, end: `${match[3].padStart(2, "0")}:${match[4]}` }
    : null;
}

function timeMatches(value: string, start: string, end: string): boolean {
  const range = timeRange(value);
  return range?.start === start && range.end === end;
}

function positiveId(value: string | null, label: string): string {
  if (!value || !/^\d+$/u.test(value) || Number(value) <= 0) {
    throw new UsageError(`The HKUL booking ${label} id must be a positive integer.`);
  }
  return value;
}

function safeHttpsUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseCount(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value.trim())) return undefined;
  return Number(value);
}

function text(node: HTMLElement): string {
  return normalizedText(node.textContent || "");
}

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
