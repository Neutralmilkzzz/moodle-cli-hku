import { parse, type HTMLElement } from "node-html-parser";

import { UsageError } from "./errors.js";

export interface CseActivity {
  code: string;
  name: string;
  individual: boolean;
  group: boolean;
}

export interface CseVenue {
  code: string;
  name: string;
}

export interface CseRoom {
  code: string;
  name: string;
}

export interface CseSlot {
  venue_code: string;
  venue: string;
  room_code: string;
  room: string;
  date: string;
  time: string;
  start_time: string;
  end_time: string;
  status: string;
  available: boolean;
}

export interface CseCalendar {
  activity_code: string;
  activity: string;
  date: string;
  venues: CseVenue[];
  rooms: CseRoom[];
  slots: CseSlot[];
}

export interface CseBookingPlan {
  service: "cse";
  activity_code: string;
  activity: string;
  date: string;
  venue_code: string;
  venue: string;
  room_code: string;
  room: string;
  time: string;
  start_time: string;
  end_time: string;
  warnings: string[];
}

export function parseCseActivities(html: string): CseActivity[] {
  const root = parse(html);
  const activities = root.querySelectorAll("a[href]").flatMap(link => {
    const href = link.getAttribute("href") ?? "";
    const match = /goToActivity\(['"]([^'"]+)['"]\)/iu.exec(href);
    if (!match) return [];
    const name = clean(link.textContent);
    const row = link.closest("tr");
    const cells = row?.querySelectorAll("td") ?? [];
    return [{
      code: match[1]!,
      name,
      individual: clean(cells[1]?.textContent).toLowerCase() === "yes",
      group: clean(cells[2]?.textContent).toLowerCase() === "yes",
    }];
  });
  return [...new Map(activities.map(activity => [activity.code, activity])).values()];
}

export function resolveCseActivity(activities: readonly CseActivity[], wanted: string): CseActivity {
  const normalized = wanted.trim().toLowerCase();
  const comparable = normalize(wanted);
  let matches = activities.filter(activity =>
    activity.code.toLowerCase() === normalized
    || activity.name.toLowerCase() === normalized
    || normalize(activity.name) === comparable);
  if (!matches.length && comparable) {
    matches = activities.filter(activity => normalize(activity.name).includes(comparable));
  }
  if (matches.length !== 1) {
    throw new UsageError(
      `CSE activity '${wanted}' was ${matches.length ? "ambiguous" : "not found"}.`,
      "Run `hku facilities cse activities` and use the exact activity name or code.",
    );
  }
  return matches[0]!;
}

export function parseCseCalendar(html: string): CseCalendar {
  const root = parse(html);
  const activityCode = root.querySelector('input[name="act_type_code"]')?.getAttribute("value")?.trim() ?? "";
  const activity = root.querySelector('input[name="activity_name"]')?.getAttribute("value")?.trim() ?? "";
  const rawDate = root.querySelector('input[name="mydate"]')?.getAttribute("value")?.trim() ?? "";
  const date = cseDate(rawDate);
  const venueSelect = root.querySelector('select[name="ft_code_centre_code"]');
  const domVenues = (venueSelect?.querySelectorAll("option") ?? []).flatMap(option => {
    const code = option.getAttribute("value")?.trim() ?? "";
    const name = clean(option.textContent);
    return code && name ? [{ code, name }] : [];
  });
  const venues = domVenues.length ? domVenues : regexVenues(html);
  const rooms = cseRooms(root);
  const slots: CseSlot[] = [];
  for (const table of root.querySelectorAll("table")) {
    const rows = table.querySelectorAll("tr");
    const timeRows = rows.filter(row => timeRange(clean(row.querySelectorAll("td")[0]?.textContent)));
    if (!timeRows.length) continue;
    const header = rows.find(row => {
      const cells = row.querySelectorAll("td");
      return cells.length > 1 && !timeRange(clean(cells[0]?.textContent));
    });
    if (!header) continue;
    const roomCodes = header.querySelectorAll("td").slice(1).map(cell => clean(cell.textContent)).filter(Boolean);
    for (const row of timeRows) {
      const cells = row.querySelectorAll("td");
      const time = clean(cells[0]?.textContent);
      const range = timeRange(time);
      if (!range) continue;
      roomCodes.forEach((roomCode, index) => {
        const cell = cells[index + 1];
        if (!cell) return;
        const status = clean(cell.textContent).toUpperCase().slice(0, 1);
        const room = rooms.find(item => item.code === roomCode);
        const venueCode = venues[0]?.code ?? "";
        slots.push({
          venue_code: venueCode,
          venue: venues[0]?.name ?? "",
          room_code: roomCode,
          room: room?.name ?? roomCode,
          date,
          time,
          start_time: range.start,
          end_time: range.end,
          status,
          available: status === "A",
        });
      });
    }
  }
  return { activity_code: activityCode, activity, date, venues, rooms, slots };
}

export function parseCseBookingReceipt(html: string): {
  success: boolean;
  reference_number?: string;
  message: string;
} {
  const text = clean(parse(html).textContent);
  const success = /booking\s+(?:is\s+)?(?:successful|confirmed)|successfully\s+booked/iu.test(text);
  const reference = /(?:reference|booking\s*(?:no|number|ref))\s*[:#]?\s*([A-Z0-9-]{5,})/iu.exec(text)?.[1];
  return {
    success,
    ...(reference ? { reference_number: reference } : {}),
    message: text.slice(0, 2_000),
  };
}

function cseRooms(root: HTMLElement): CseRoom[] {
  return root.querySelectorAll('input[name^="detail"]').flatMap(input => {
    const raw = input.getAttribute("value")?.trim() ?? "";
    const parts = raw.split(/\s+--\s+/u);
    const code = parts[0];
    const name = parts[1];
    return code
      ? [{ code, name: name?.trim().replace(/\s+--\s*$/u, "") || code }]
      : [];
  });
}

function regexVenues(html: string): CseVenue[] {
  const select = /<select\b[^>]*name=["']ft_code_centre_code["'][^>]*>([\s\S]*?)<\/select>/iu.exec(html)?.[1] ?? "";
  return [...select.matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)(?=<\/option>|<option\b|<\/select>|$)/giu)]
    .flatMap(match => {
      const code = match[1]!.trim();
      const name = clean(match[2]!.replace(/<[^>]+>/gu, " "));
      return code && name ? [{ code, name }] : [];
    });
}

function cseDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : value;
}

function timeRange(value: string): { start: string; end: string } | null {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  return {
    start: `${match[1]!.padStart(2, "0")}:${match[2]}`,
    end: `${match[3]!.padStart(2, "0")}:${match[4]}`,
  };
}

function clean(value: string | undefined): string {
  return (value ?? "")
    .replace(/[\u0091\u0092]/gu, "'")
    .replace(/[\u0093\u0094]/gu, '"')
    .replace(/[\u0096\u0097]/gu, "-")
    .replace(/[\u0080-\u009f]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}
