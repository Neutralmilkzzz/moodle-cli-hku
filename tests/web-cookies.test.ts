import { describe, expect, it } from "vitest";

import { CookieJar, parseSetCookie } from "../src/web-cookies.js";

describe("web cookie jar", () => {
  it("scopes cookies to their domain and path", () => {
    const jar = new CookieJar([
      { name: "root", value: "one", domain: "hku.hk", path: "/" },
      { name: "booking", value: "two", domain: "booking.lib.hku.hk", path: "/Secure" },
    ]);
    expect(jar.header("https://booking.lib.hku.hk/Secure/FacilityStatusDate.aspx")).toContain("root=one");
    expect(jar.header("https://booking.lib.hku.hk/Secure/FacilityStatusDate.aspx")).toContain("booking=two");
    expect(jar.header("https://booking.lib.hku.hk/public")).toContain("root=one");
    expect(jar.header("https://booking.lib.hku.hk/public")).not.toContain("booking=two");
    expect(jar.header("https://example.com/")).toBe("");
  });

  it("parses secure cookies and receives public suffix-safe domains", () => {
    const cookie = parseSetCookie(
      "ASP.NET_SessionId=abc; Path=/; Secure; HttpOnly; Domain=.booking.lib.hku.hk",
      "https://booking.lib.hku.hk/Secure/Redirect.aspx",
    );
    expect(cookie).toMatchObject({
      name: "ASP.NET_SessionId",
      value: "abc",
      domain: "booking.lib.hku.hk",
      path: "/",
      secure: true,
      httpOnly: true,
    });
  });
});
