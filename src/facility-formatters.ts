import type { FacilityService } from "./facilities.js";
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
