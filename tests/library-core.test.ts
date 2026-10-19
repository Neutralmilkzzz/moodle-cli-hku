import { describe, expect, it } from "vitest";

import {
  bookingWasAccepted,
  buildBookingConfirmationSubmission,
  buildBookingSubmission,
  buildBookingUrl,
  confirmationMatches,
  parseBookingForm,
  parseBookingRecords,
  parseBookingUrl,
  parseLibraryFacilities,
  parseLibraryAvailabilityPage,
} from "../src/library-core.js";

describe("HKU Library core", () => {
  it("merges the official facility table with live availability counts", () => {
    const page = `
      <span id="Time">2026 Oct 19 14:00:00</span>
      <table>
        <tr class="trLibName"><td>Main Library</td></tr>
        <tr class="trLibItem">
          <td><a href="https://booking.lib.hku.hk/FView.aspx?lib=3&amp;ftype=21">Discussion Rooms (Level 3)</a></td>
          <td><span class="textavail" id="MAI03DRA">*</span></td>
          <td><span class="texttotal" id="MAI03DRT">*</span></td>
        </tr>
        <tr class="trLibName"><td>Law Library</td></tr>
        <tr class="trLibItem">
          <td><a href="https://booking.lib.hku.hk/FView.aspx?lib=6&amp;ftype=12">Discussion rooms</a></td>
          <td><span class="textavail" id="LAW02DRA">*</span></td>
          <td><span class="texttotal" id="LAW02DRT">*</span></td>
        </tr>
      </table>`;
    const availability = `
      <div id="MAI03DR_CntA">4</div><div id="MAI03DR_CntT">8</div>
      <div id="LAW02DR_CntA">0</div><div id="LAW02DR_CntT">4</div>`;

    const result = parseLibraryFacilities(page, availability);
    expect(result.updated_at).toBe("2026 Oct 19 14:00:00");
    expect(result.facilities).toEqual([
      expect.objectContaining({
        library: "Main Library",
        type: "Discussion Rooms (Level 3)",
        available: 4,
        total: 8,
        source_id: "MAI03DR",
      }),
      expect.objectContaining({
        library: "Law Library",
        type: "Discussion rooms",
        available: 0,
        total: 4,
      }),
    ]);
  });

  it("parses and rebuilds an official slot URL", () => {
    const url = "https://booking.lib.hku.hk/Secure/NewBooking.aspx?library=3&ftype=21&facility=129&date=20260920&session=2";
    const target = parseBookingUrl(url);
    expect(target).toMatchObject({
      library_id: "3",
      facility_type_id: "21",
      facility_id: "129",
      date: "2026-09-20",
      session_index: 2,
    });
    expect(buildBookingUrl({
      libraryId: "3",
      facilityTypeId: "21",
      facilityId: "129",
      date: "2026-09-20",
      sessionIndex: 2,
    })).toBe(url);
    expect(() => parseBookingUrl("https://example.com/Secure/NewBooking.aspx")).toThrow("HKUL NewBooking");
  });

  it("checks the exact form session and builds both ASP.NET submissions", () => {
    const target = parseBookingUrl(
      "https://booking.lib.hku.hk/Secure/NewBooking.aspx?library=3&ftype=21&facility=129&date=20260920&session=2",
    );
    const page = `
      <html><body>
        <h1>New Booking</h1>
        <form method="post">
          <input type="hidden" name="__VIEWSTATE" value="state" />
          <input type="hidden" name="__EVENTVALIDATION" value="events" />
          <select id="main_ddlLibrary" name="ctl00$main$ddlLibrary">
            <option selected>Main Library</option>
          </select>
          <select id="main_ddlFloor" name="ctl00$main$ddlFloor">
            <option selected>Level 3</option>
          </select>
          <select id="main_ddlType" name="ctl00$main$ddlType">
            <option selected>Discussion Room</option>
          </select>
          <select id="main_ddlFacility" name="ctl00$main$ddlFacility">
            <option selected>Discussion Room 18</option>
          </select>
          <select id="main_ddlDate" name="ctl00$main$ddlDate">
            <option selected>2026-09-20 (Sun)</option>
          </select>
          <input id="s0" type="checkbox" name="ctl00$main$listSession$0" value="08300930" />
          <label for="s0">08:30 - 09:30</label>
          <input id="s1" type="checkbox" name="ctl00$main$listSession$1" value="09301030" checked />
          <label for="s1">09:30 - 10:30</label>
          <input id="s2" type="checkbox" name="ctl00$main$listSession$2" value="10301130" />
          <label for="s2">10:30 - 11:30</label>
          <input id="submit" type="submit" name="ctl00$main$btnSubmit" value="Submit" />
        </form>
      </body></html>`;

    const formPlan = parseBookingForm(page, target, { startTime: "09:30", endTime: "10:30" });
    expect(formPlan.plan).toMatchObject({
      location: "Main Library",
      floor: "Level 3",
      facility_type: "Discussion Room",
      facility: "Discussion Room 18",
      date: "2026-09-20",
      start_time: "09:30",
      end_time: "10:30",
      marked: true,
    });
    const first = buildBookingSubmission(formPlan, { description: "Study" });
    expect(first.values["ctl00$main$listSession$1"]).toBe("09301030");
    expect(first.values["ctl00$main$listSession$0"]).toBeUndefined();
    expect(first.values["ctl00$main$btnSubmit"]).toBe("Submit");
    expect(first.values["ctl00$main$txtUserDescription"]).toBe("Study");

    const confirmation = `
      <div>Please confirm the following booking.
      Facility Type : Discussion Room
      Facility : Discussion Room 18
      Date : 2026-09-20 (Sun)
      Session : 09:30 - 10:30</div>
      <input id="main_btnSubmitYes" type="submit" name="ctl00$main$btnSubmitYes" value="Yes" />`;
    expect(confirmationMatches(confirmation, formPlan.plan)).toBe(true);
    const second = buildBookingConfirmationSubmission(first.values, confirmation);
    expect(second.values["ctl00$main$btnSubmitYes"]).toBe("Yes");
    expect(second.values.__ASYNCPOST).toBeUndefined();
    expect(bookingWasAccepted("<p>Your Booking is successful</p>")).toBe(true);
  });

  it("parses paginated availability rows into exact booking links", () => {
    const html = `
      <form><select id="main_ddlPage" name="ctl00$main$ddlPage">
        <option value="1" selected>1</option><option value="2">2</option>
      </select></form>
      <table id="main_2">
        <tr><th>Floor</th><th>Facility</th><th>22:00 - 23:00</th><th>23:00 - 23:45</th></tr>
        <tr><td>CPD-1</td><td>Study Room 5</td><td></td>
          <td><a href="NewBooking.aspx?library=5&amp;ftype=29&amp;facility=261&amp;date=20261019&amp;session=23002345">Select</a></td>
        </tr>
      </table>`;
    const result = parseLibraryAvailabilityPage(html, "https://booking.lib.hku.hk/Secure/FacilityStatusDate.aspx");
    expect(result).toMatchObject({ page: 1, page_count: 2 });
    expect(result.slots).toEqual([{
      floor: "CPD-1",
      room: "Study Room 5",
      start_time: "23:00",
      end_time: "23:45",
      booking_url: "https://booking.lib.hku.hk/Secure/NewBooking.aspx?library=5&ftype=29&facility=261&date=20261019&session=23002345",
    }]);
  });

  it("parses booking records with separate start and end columns", () => {
    const html = `
      <table id="main_gvRecord">
        <tr><th></th><th>Start</th><th>End</th><th>Location</th><th>Floor</th><th>Facility</th><th>Status</th></tr>
        <tr><td></td><td>2026-10-19 (Mon) 23:00</td><td>2026-10-19 (Mon) 23:45</td>
          <td>Chi Wah Learning Commons</td><td>CPD-1</td><td>Study Room 5</td><td>Booked</td></tr>
      </table>`;
    expect(parseBookingRecords(html)).toEqual([{
      date: "2026-10-19",
      time: "23:00 - 23:45",
      start: "23:00",
      end: "23:45",
      location: "Chi Wah Learning Commons",
      floor: "CPD-1",
      facility: "Study Room 5",
      status: "Booked",
    }]);
  });
});
