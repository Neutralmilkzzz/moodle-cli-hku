import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildHkufbsSearchBody,
  hongKongIso,
  parseHkufbsAttributes,
  parseHkufbsCatalog,
  parseHkufbsOpenings,
  parseHkufbsResourceRules,
  parseHkufbsReservationPage,
  parseHkufbsSaveReceipt,
  resolveHkufbsResource,
} from "../src/hkufbs-core.js";

const PAGE_URL = "https://hkufbs.hku.hk/fbs/centralbook/book/Web/search-availability.php";

describe("HKUFBS page parsing", () => {
  it("reads the search controls and available openings", async () => {
    const html = await readFile(join(import.meta.dirname, "fixtures/hkufbs/search-availability.html"), "utf8");
    const catalog = parseHkufbsCatalog(html, PAGE_URL);
    expect(catalog).toMatchObject({
      csrf_token: "test-csrf-token",
      schedules: [
        { id: "0", name: "All Schedules" },
        { id: "253", name: "CEDARS - CYMAC - Band Room" },
      ],
    });
    expect(catalog.resources).toHaveLength(2);
    expect(catalog.action).toContain("action=search");

    const openings = parseHkufbsOpenings(html, PAGE_URL, catalog);
    expect(openings).toEqual([
      expect.objectContaining({
        resource_id: "1497",
        resource: "CEDARS - CYMAC - Band Room",
        date: "2026-10-23",
        start_time: "10:00",
        end_time: "11:00",
      }),
      expect.objectContaining({
        resource_id: "2871",
        resource: "FSCAC - Music Room - 1A08",
        start_time: "14:00",
      }),
    ]);
    expect(openings[0]?.reservation_url).toContain("rid=1497");
  });

  it("builds duration and exact-time searches without accepting unsafe ranges", async () => {
    const html = await readFile(join(import.meta.dirname, "fixtures/hkufbs/search-availability.html"), "utf8");
    const catalog = parseHkufbsCatalog(html, PAGE_URL);
    const duration = buildHkufbsSearchBody(catalog, {
      date: "2026-10-23",
      resource: "FSCAC Music Room 1A08",
      durationMinutes: 90,
    });
    expect(duration.getAll("resourceId[]")).toEqual(["2871"]);
    expect(duration.get("AVAILABILITY_SEARCH_TYPE")).toBe("1");
    expect(duration.get("HOURS")).toBe("1");
    expect(duration.get("MINUTES")).toBe("30");
    expect(duration.get("ANY_TIME")).toBe("on");

    const exact = buildHkufbsSearchBody(catalog, {
      date: "2026-10-23",
      resource: "1497",
      start: "14:00",
      end: "15:30",
    });
    expect(exact.get("AVAILABILITY_SEARCH_TYPE")).toBe("1");
    expect(exact.get("HOURS")).toBe("1");
    expect(exact.get("MINUTES")).toBe("30");
    expect(exact.get("beginTime")).toBe("2:00 PM");
    expect(exact.get("endTime")).toBe("3:30 PM");
    expect(exact.get("ANY_TIME")).toBe("on");
    expect(() => buildHkufbsSearchBody(catalog, { date: "2026-10-23", start: "10:00" })).toThrow(/both/u);
  });

  it("resolves exact rooms and Hong Kong timestamps", async () => {
    const html = await readFile(join(import.meta.dirname, "fixtures/hkufbs/search-availability.html"), "utf8");
    const catalog = parseHkufbsCatalog(html, PAGE_URL);
    expect(resolveHkufbsResource(catalog, "1497")).toMatchObject({ id: "1497" });
    expect(resolveHkufbsResource(catalog, "fscac - music room - 1a08")).toMatchObject({ id: "2871" });
    expect(hongKongIso("2026-10-23", "10:00")).toBe("2026-10-23T02:00:00.000Z");
    expect(hongKongIso("2026-10-23", "23:30")).toBe("2026-10-23T15:30:00.000Z");
  });

  it("reads signed-in reservation state and custom attribute requirements", () => {
    expect(parseHkufbsReservationPage(`
      <script>const csrf = "abc"; const userId = 170257; const loggedIn = true;</script>
    `)).toEqual({ csrf_token: "abc", owner_id: 170257, logged_in: true });

    expect(parseHkufbsAttributes({
      data: {
        attributes: [
          { id: 26, label: "Contact No.", required: true },
          { id: 31, label: "Staff/Student UID No.", required: true },
        ],
      },
    })).toEqual([
      { id: 26, label: "Contact No.", required: true, regex: undefined },
      { id: 31, label: "Staff/Student UID No.", required: true, regex: undefined },
    ].map(({ regex: _regex, ...attribute }) => attribute));
  });

  it("distinguishes accepted, pending and rejected save responses", () => {
    expect(parseHkufbsSaveReceipt({
      data: { success: true, referenceNumber: "REF-1", requiresApproval: true, errors: [] },
    })).toEqual({
      success: true,
      reference_number: "REF-1",
      requires_approval: true,
      errors: [],
    });
    expect(parseHkufbsSaveReceipt({
      data: { success: false, errors: [{ errorMessage: "Room unavailable" }] },
    })).toEqual({ success: false, errors: ["Room unavailable"] });
  });

  it("extracts live room notice and duration rules", () => {
    expect(parseHkufbsResourceRules({
      data: {
        resources: [{
          id: 2871,
          name: "FSCAC - Music Room - 1A08",
          noticeAdd: { days: 3, hours: 0, minutes: 0 },
          minDuration: { days: 0, hours: 1, minutes: 0 },
          maxDuration: { days: 0, hours: 2, minutes: 0 },
          requiresApproval: false,
          notes: "For musical purposes only.",
        }],
      },
    }, "2871")).toEqual({
      id: "2871",
      name: "FSCAC - Music Room - 1A08",
      notice_add_minutes: 4320,
      min_duration_minutes: 60,
      max_duration_minutes: 120,
      requires_approval: false,
      notes: "For musical purposes only.",
    });
  });
});
