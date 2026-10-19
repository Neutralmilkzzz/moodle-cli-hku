import { describe, expect, it } from "vitest";

import { parseCsePage } from "../src/cse.js";

describe("CSE Sports Booking portal", () => {
  it("reads the signed-in module page without exposing external links", () => {
    const page = parseCsePage(`
      <html>
        <head><title>Sports Facilities Booking</title></head>
        <body>
          <h1>Sports Facilities Booking</h1>
          <a href="/ihpbooking/servlet/IHP_Main/showModule?module=booking">Book a facility</a>
          <a href="https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Booking/showCalendar">My bookings</a>
          <a href="https://example.com/phishing">Open external</a>
          <a href="javascript:void(0)">Menu</a>
        </body>
      </html>
    `, "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Main/showModule");

    expect(page.title).toBe("Sports Facilities Booking");
    expect(page.text).toContain("Book a facility");
    expect(page.links).toEqual([
      {
        text: "Book a facility",
        url: "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Main/showModule?module=booking",
      },
      {
        text: "My bookings",
        url: "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Booking/showCalendar",
      },
    ]);
  });
});
