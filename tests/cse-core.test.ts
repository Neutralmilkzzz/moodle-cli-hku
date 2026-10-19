import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseCseActivities,
  parseCseCalendar,
  resolveCseActivity,
} from "../src/cse-core.js";

describe("CSE booking page parsing", () => {
  it("reads activities and booking modes", async () => {
    const html = await readFile(join(import.meta.dirname, "fixtures/cse/activities.html"), "utf8");
    const activities = parseCseActivities(html);
    expect(activities).toEqual([
      {
        code: "Badminton::1",
        name: "Badminton: max 4 active players per court",
        individual: true,
        group: true,
      },
      {
        code: "Athletics::1",
        name: "Athletics: Field Event Only",
        individual: false,
        group: true,
      },
    ]);
    expect(resolveCseActivity(activities, "badminton").code).toBe("Badminton::1");
  });

  it("reads room availability from the calendar matrix", async () => {
    const html = await readFile(join(import.meta.dirname, "fixtures/cse/calendar.html"), "utf8");
    const calendar = parseCseCalendar(html);
    expect(calendar).toMatchObject({
      activity_code: "Badminton::1",
      activity: "Badminton: max 4 active players per court",
      date: "2026-10-20",
      rooms: [
        { code: "WISSH1", name: "West Island School Sports Hall Court#1" },
        { code: "WISSH2", name: "West Island School Sports Hall Court#2" },
      ],
    });
    expect(calendar.slots.filter(slot => slot.available)).toEqual([
      expect.objectContaining({ room_code: "WISSH1", start_time: "09:30", end_time: "10:30" }),
      expect.objectContaining({ room_code: "WISSH1", start_time: "10:30", end_time: "11:30" }),
      expect.objectContaining({ room_code: "WISSH2", start_time: "10:30", end_time: "11:30" }),
    ]);
  });

  it("recovers venue options from the legacy malformed select markup", () => {
    const calendar = parseCseCalendar(`
      <form>
        <select name="ft_code_centre_code"><option value="WISM">West Island School Sports Facilities</select>
        <input name="act_type_code" value="Badminton::1">
        <input name="mydate" value="19/10/2026">
      </form>
    `);
    expect(calendar.venues).toEqual([
      { code: "WISM", name: "West Island School Sports Facilities" },
    ]);
  });
});
