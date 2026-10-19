import { describe, expect, it } from "vitest";

import { prepareFacilityRequest } from "../src/facility-requests.js";

describe("facility request preparation", () => {
  const monday = new Date("2026-10-19T02:00:00.000Z");

  it("calculates eight weeks for the Library Venue form", () => {
    const plan = prepareFacilityRequest({
      service: "library-venue",
      eventDate: "2026-12-15",
      purpose: "Research workshop",
      attendees: 25,
      now: monday,
    });
    expect(plan).toMatchObject({
      service: "HKUL Library Venue",
      earliest_event_date: "2026-12-14",
      latest_submission_date: "2026-10-20",
      eligible: true,
      notice: { value: 56, unit: "calendar days" },
    });
    expect(plan.checklist.join("\n")).toContain("Research workshop");
  });

  it("counts ten working days for DIL and LIC forms", () => {
    const plan = prepareFacilityRequest({
      service: "dil",
      eventDate: "2026-11-03",
      now: monday,
    });
    expect(plan.earliest_event_date).toBe("2026-11-02");
    expect(plan.latest_submission_date).toBe("2026-10-20");
    expect(plan.eligible).toBe(true);

    expect(prepareFacilityRequest({
      service: "lic-classroom",
      eventDate: "2026-10-30",
      now: monday,
    }).eligible).toBe(false);
  });

  it("prepares the 28-day CSE internal group request", () => {
    const plan = prepareFacilityRequest({
      service: "cse-group",
      eventDate: "2026-11-16",
      purpose: "Inter-hall tournament",
      now: monday,
    });
    expect(plan).toMatchObject({
      service: "CSE Internal Group Sports Booking",
      earliest_event_date: "2026-11-16",
      eligible: true,
      notice: { value: 28, unit: "calendar days" },
    });
    expect(plan.form_url).toMatch(/^mailto:csebooking\.officer@hku\.hk/u);
  });

  it("rejects invalid dates and services without request forms", () => {
    expect(() => prepareFacilityRequest({
      service: "library-venue",
      eventDate: "2026-02-30",
      now: monday,
    })).toThrow(/invalid/u);
    expect(() => prepareFacilityRequest({
      service: "hkufbs",
      eventDate: "2026-11-03",
      now: monday,
    })).toThrow(/booked through/u);
  });
});
