import { describe, expect, it } from "vitest";

import { parseLibraryBookings, parseLibraryGrid } from "../src/hku-library.js";

describe("HKU library page parsing", () => {
  it("extracts available sessions and booking links", () => {
    const grid = parseLibraryGrid(`
      <table>
        <tr><th>Floor</th><th>Facility</th><th>10:00 - 11:00</th><th>11:00 - 12:00</th></tr>
        <tr>
          <td>2/F</td><td>Study Room Study Room A</td>
          <td class="available"><a href="NewBooking.aspx?facility=12&amp;session=10001100">Select</a></td>
          <td class="booked">Booked</td>
        </tr>
      </table>
    `, "https://booking.lib.hku.hk/Secure/FacilityStatusDate.aspx", {
      location: "Chi Wah Learning Commons",
      facilityType: "Study Room",
      date: "2026-10-19",
    });

    expect(grid.rooms[0]).toMatchObject({
      floor: "2/F",
      name: "Study Room A",
      availableSessions: ["10:00 - 11:00"],
    });
    expect(grid.rooms[0].slots[0]).toMatchObject({
      session: "10:00 - 11:00",
      code: "10001100",
      available: true,
    });
  });

  it("extracts records from My Booking Record", () => {
    const bookings = parseLibraryBookings(`
      <table id="main_gvRecord">
        <tr><th>#</th><th>Start Date/Time</th><th>End Date/Time</th><th>Location</th><th>Floor</th><th>Facility</th><th>Status</th></tr>
        <tr><td>1</td><td>2026-10-19 10:00</td><td>2026-10-19 11:00</td><td>Chi Wah</td><td>2/F</td><td>Room A</td><td>Confirmed</td></tr>
      </table>
    `);

    expect(bookings).toEqual([{
      start: "2026-10-19 10:00",
      end: "2026-10-19 11:00",
      location: "Chi Wah",
      floor: "2/F",
      facility: "Room A",
      status: "Confirmed",
    }]);
  });
});
