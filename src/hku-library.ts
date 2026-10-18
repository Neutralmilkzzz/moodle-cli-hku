import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ALL_PROFILES, getCookies } from "@steipete/sweet-cookie";
import { parse, type HTMLElement } from "node-html-parser";
import { Cookie, CookieJar } from "tough-cookie";

import { writeFileAtomic } from "./atomic-write.js";
import { loginWithCdp, type CdpCookie } from "./cdp-login.js";
import { AuthError } from "./errors.js";
import { hkuConfigDir } from "./hku-mail.js";

export const LIBRARY_BOOKING_URL = "https://booking.lib.hku.hk/Secure/FacilityStatusDate.aspx";
export const LIBRARY_MY_BOOKINGS_URL = "https://booking.lib.hku.hk/Secure/MyBookingRecord.aspx";
const LIBRARY_AUTH_ORIGIN = "https://booking.lib.hku.hk";

const LIBRARY_SELECT = "ctl00$main$ddlLibrary";
const TYPE_SELECT = "ctl00$main$ddlType";
const VIEW_SELECT = "ctl00$main$ddlView";
const SEARCH_BUTTON = "ctl00$main$btnGetResult";
const SUBMIT_BUTTON = "ctl00$main$btnSubmit";
const YES_BUTTON = "ctl00$main$btnSubmitYes";
const SKIP_EMAIL_BUTTON = "ctl00$main$btnSkipEmail";
const DESCRIPTION_FIELD = "ctl00$main$txtUserDescription";

const CONFIRM_MARKERS = ["please confirm", "are you sure"];
const EMAIL_MARKERS = ["booking acknowledgment", "e-mail address"];
const RESULT_MARKERS = ["booking result", "booking reference", "reference no"];

export interface LibraryCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

export interface LibraryOption {
  value: string;
  text: string;
}

export interface LibrarySlot {
  session: string;
  code: string;
  available: boolean;
  bookingUrl: string | null;
}

export interface LibraryRoom {
  floor: string;
  name: string;
  availableSessions: string[];
  slots: LibrarySlot[];
}

export interface LibraryGrid {
  location: string;
  facilityType: string;
  date: string;
  sessions: string[];
  rooms: LibraryRoom[];
}

export interface LibraryBooking {
  start: string;
  end: string;
  location: string;
  floor: string;
  facility: string;
  status: string;
}

export interface LibraryBookResult {
  steps: string[];
  url: string;
  text: string;
  bookings: LibraryBooking[];
}

export interface LibraryClientOptions {
  cookies?: LibraryCookie[];
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface LibraryCookieOptions {
  homeDir?: string;
}

export class LibraryError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = "LibraryError";
  }
}

export class LibraryAuthRequiredError extends AuthError {
  constructor(message = "The HKU library session is missing or expired.") {
    super(message, "Run: hku library auth login");
    this.name = "LibraryAuthRequiredError";
  }
}

export function libraryCookiePath(homeDir = homedir()): string {
  return join(hkuConfigDir(homeDir), "library-cookies.json");
}

function clean(value: string): string {
  return (value || "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

function cookieFrom(value: LibraryCookie): Cookie | null {
  if (!value.name || !value.domain) return null;
  return new Cookie({
    key: value.name,
    value: value.value,
    domain: value.domain,
    path: value.path || "/",
    secure: value.secure === true,
    httpOnly: value.httpOnly === true,
    ...(typeof value.expires === "number" && value.expires > 0
      ? { expires: new Date(value.expires * 1000) }
      : {}),
  });
}

function sameCookie(left: LibraryCookie, right: LibraryCookie): boolean {
  return left.name === right.name
    && left.domain === right.domain
    && (left.path || "/") === (right.path || "/");
}

export function uniqueLibraryCookies(cookies: LibraryCookie[]): LibraryCookie[] {
  const values = new Map<string, LibraryCookie>();
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value || !cookie.domain) continue;
    const key = `${cookie.domain.toLowerCase()}\0${cookie.path || "/"}\0${cookie.name}`;
    values.set(key, cookie);
  }
  return [...values.values()];
}

export async function saveLibraryCookies(
  cookies: LibraryCookie[],
  options: LibraryCookieOptions = {},
): Promise<string> {
  const path = libraryCookiePath(options.homeDir);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    saved_at: new Date().toISOString(),
    cookies: uniqueLibraryCookies(cookies),
  };
  await writeFileAtomic(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, directoryMode: 0o700 });
  await chmod(path, 0o600).catch(() => undefined);
  return path;
}

export async function readSavedLibraryCookies(
  options: LibraryCookieOptions = {},
): Promise<LibraryCookie[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(libraryCookiePath(options.homeDir), "utf8"));
    if (!parsed || typeof parsed !== "object") return [];
    const values = (parsed as { cookies?: unknown }).cookies;
    if (!Array.isArray(values)) return [];
    return values.filter((value): value is LibraryCookie => {
      if (!value || typeof value !== "object") return false;
      const cookie = value as Partial<LibraryCookie>;
      return typeof cookie.name === "string"
        && typeof cookie.value === "string"
        && typeof cookie.domain === "string";
    });
  } catch {
    return [];
  }
}

export async function readBrowserLibraryCookies(): Promise<LibraryCookie[]> {
  const urls = [
    LIBRARY_BOOKING_URL,
    "https://lib.hku.hk/",
    "https://hkuportal.hku.hk/",
    "https://adfs.connect.hku.hk/",
  ];
  const collected: LibraryCookie[] = [];
  for (const url of urls) {
    const edge = await getCookies({
      url,
      browsers: ["edge"],
      edgeProfile: ALL_PROFILES,
      mode: "merge",
    }).catch(() => ({ cookies: [] as Array<Record<string, unknown>> }));
    const browser = edge.cookies.length
      ? edge
      : await getCookies({
        url,
        browsers: ["chrome", "firefox"],
        chromeProfile: ALL_PROFILES,
        firefoxProfile: ALL_PROFILES,
        mode: "merge",
      }).catch(() => ({ cookies: [] as Array<Record<string, unknown>> }));
    for (const cookie of browser.cookies) {
      const raw = cookie as {
        name?: string;
        value?: string;
        domain?: string;
        path?: string;
        secure?: boolean;
        httpOnly?: boolean;
        expires?: number;
      };
      if (raw.name && raw.value && raw.domain) {
        collected.push({
          name: raw.name,
          value: raw.value,
          domain: raw.domain,
          path: raw.path,
          secure: raw.secure,
          httpOnly: raw.httpOnly,
          expires: raw.expires,
        });
      }
    }
  }
  return uniqueLibraryCookies(collected);
}

export async function resolveLibraryCookies(
  options: LibraryCookieOptions = {},
): Promise<LibraryCookie[]> {
  const saved = await readSavedLibraryCookies(options);
  if (saved.length) return saved;
  const browser = await readBrowserLibraryCookies();
  if (browser.length) await saveLibraryCookies(browser, options);
  return browser;
}

function toLibraryCookies(cookies: CdpCookie[]): LibraryCookie[] {
  return uniqueLibraryCookies(cookies.map(cookie => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  })));
}

function looksLoggedIn(cookies: CdpCookie[]): boolean {
  const names = new Set(cookies.map(cookie => cookie.name));
  return names.has("ASP.NET_SessionId")
    && (names.has("CAS.AAD.SESSION.COOKIE") || names.has("MSISAuth") || names.has("shibbolethsp"));
}

export async function loginLibrary(options: LibraryCookieOptions = {}): Promise<{
  cookie_path: string;
  cookies: number;
  authenticated: boolean;
}> {
  const result = await loginWithCdp({
    url: LIBRARY_BOOKING_URL,
    profileDir: join(hkuConfigDir(options.homeDir), "library-browser-profile"),
    isDone: cookies => looksLoggedIn(cookies),
  });
  const cookies = toLibraryCookies(result.cookies);
  const path = await saveLibraryCookies(cookies, options);
  const client = new HkuLibraryClient({ cookies });
  const authenticated = await client.isAuthenticated();
  if (!authenticated) {
    throw new LibraryAuthRequiredError(
      `Signed in through ${result.browserName}, but the booking service still rejected the session.`,
    );
  }
  return { cookie_path: path, cookies: cookies.length, authenticated };
}

async function setCookiesFromResponse(jar: CookieJar, response: Response, requestUrl: string): Promise<void> {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = headers.getSetCookie?.() ?? [];
  const single = response.headers.get("set-cookie");
  if (!values.length && single) values.push(single);
  for (const value of values) {
    await jar.setCookie(value, requestUrl).catch(() => undefined);
  }
}

function hiddenFields(root: HTMLElement): Record<string, string> {
  const data: Record<string, string> = {};
  for (const input of root.querySelectorAll('input[type="hidden"]')) {
    const name = input.getAttribute("name");
    if (name) data[name] = input.getAttribute("value") ?? "";
  }
  return data;
}

function selectOptions(root: HTMLElement, name: string): LibraryOption[] {
  const select = root.querySelector(`select[name="${name}"]`);
  if (!select) return [];
  return select.querySelectorAll("option").flatMap(option => {
    const value = option.getAttribute("value") ?? "";
    const text = clean(option.text);
    if (!value || text.toLowerCase().startsWith("- please select")) return [];
    return [{ value, text }];
  });
}

function resolveOption(options: LibraryOption[], needle: string, kind: string): LibraryOption {
  const wanted = clean(needle).toLowerCase();
  if (!wanted) throw new LibraryError(`No ${kind} was provided.`);
  const exact = options.filter(option => option.text.toLowerCase() === wanted);
  if (exact.length === 1) return exact[0];
  const partial = options.filter(option => option.text.toLowerCase().includes(wanted) || option.value === wanted);
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    throw new LibraryError(
      `${kind} '${needle}' is ambiguous: ${partial.map(option => option.text).join(", ")}`,
    );
  }
  throw new LibraryError(
    `${kind} '${needle}' was not found. Known values: ${options.map(option => option.text).join(", ")}`,
  );
}

function tableRows(table: HTMLElement): string[][] {
  return table.querySelectorAll("tr").map(row => row.querySelectorAll("th,td").map(cell => clean(cell.text)));
}

function findGridTable(root: HTMLElement): HTMLElement | null {
  for (const table of root.querySelectorAll("table")) {
    const first = table.querySelector("tr")?.querySelectorAll("th,td").map(cell => clean(cell.text)) ?? [];
    if (first.length >= 3 && first[0] === "Floor" && first[1] === "Facility") return table;
  }
  return null;
}

function parseHrefParams(href: string): Record<string, string> {
  const params: Record<string, string> = {};
  const query = href.split("?", 2)[1] ?? "";
  for (const part of query.split("&")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    params[part.slice(0, index).toLowerCase()] = decodeURIComponent(part.slice(index + 1));
  }
  return params;
}

export function parseLibraryGrid(
  html: string,
  baseUrl = LIBRARY_BOOKING_URL,
  meta: { location?: string; facilityType?: string; date?: string } = {},
): LibraryGrid {
  const root = parse(html);
  const table = findGridTable(root);
  if (!table) {
    throw new LibraryAuthRequiredError(
      "The facility table was not found; the saved HKU library session may have expired.",
    );
  }
  const rows = table.querySelectorAll("tr");
  const headers = rows[0].querySelectorAll("th,td").map(cell => clean(cell.text));
  const sessions = headers.slice(2);
  const rooms: LibraryRoom[] = [];
  for (const row of rows.slice(1)) {
    const cells = row.querySelectorAll("td");
    if (cells.length < 3) continue;
    const floor = clean(cells[0].text);
    let name = clean(cells[1].text);
    if (meta.facilityType && name.toLowerCase().startsWith(meta.facilityType.toLowerCase())) {
      name = name.slice(meta.facilityType.length).trim() || name;
    }
    const slots: LibrarySlot[] = [];
    for (let index = 0; index < cells.length - 2; index += 1) {
      const cell = cells[index + 2];
      const link = cell.querySelector("a[href]");
      const href = link?.getAttribute("href") ?? "";
      const params = href ? parseHrefParams(href) : {};
      slots.push({
        session: sessions[index] ?? "",
        code: params.session ?? "",
        available: Boolean(href),
        bookingUrl: href ? new URL(href, baseUrl).toString() : null,
      });
    }
    rooms.push({
      floor,
      name,
      availableSessions: slots.filter(slot => slot.available).map(slot => slot.session),
      slots,
    });
  }
  return {
    location: meta.location ?? "",
    facilityType: meta.facilityType ?? "",
    date: meta.date ?? "",
    sessions,
    rooms,
  };
}

export function parseLibraryBookings(html: string): LibraryBooking[] {
  const root = parse(html);
  let grid = root.querySelector("table#main_gvRecord");
  if (!grid) {
    grid = root.querySelectorAll("table").find(table => {
      const headers = table.querySelector("tr")?.querySelectorAll("th,td").map(cell => clean(cell.text)) ?? [];
      return headers.includes("Start Date/Time") && headers.includes("Status");
    }) ?? null;
  }
  if (!grid) return [];
  const rows = tableRows(grid);
  if (rows.length < 2) return [];
  const width = rows[0].length;
  return rows.slice(1).flatMap(cells => {
    if (cells.length < width || width < 6) return [];
    return [{
      start: cells[1] ?? "",
      end: cells[2] ?? "",
      location: cells[3] ?? "",
      floor: cells[4] ?? "",
      facility: cells[5] ?? "",
      status: cells[6] ?? "",
    }];
  });
}

function formPayload(root: HTMLElement, sessionCode: string): { data: Record<string, string>; matched: boolean } {
  const data = hiddenFields(root);
  for (const select of root.querySelectorAll("select")) {
    const name = select.getAttribute("name");
    if (!name) continue;
    const chosen = select.querySelector("option[selected]") ?? select.querySelector("option");
    if (chosen) data[name] = chosen.getAttribute("value") ?? "";
  }
  let matched = false;
  for (const checkbox of root.querySelectorAll('input[type="checkbox"]')) {
    const name = checkbox.getAttribute("name");
    if (!name) continue;
    if ((checkbox.getAttribute("value") ?? "") === sessionCode) {
      data[name] = sessionCode;
      matched = true;
    }
  }
  return { data, matched };
}

class RequestSession {
  readonly jar = new CookieJar();
  private readonly fetcher: typeof fetch;

  constructor(cookies: LibraryCookie[], fetcher: typeof fetch) {
    this.fetcher = fetcher;
    for (const cookie of cookies) {
      const parsed = cookieFrom(cookie);
      if (parsed) {
        this.jar.setCookieSync(parsed, `https://${cookie.domain.replace(/^\./u, "")}/`);
      }
    }
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    let current = new URL(url);
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    for (let redirects = 0; redirects < 12; redirects += 1) {
      const cookie = await this.jar.getCookieString(current.toString());
      const headers = new Headers(init.headers);
      if (cookie) headers.set("Cookie", cookie);
      const response = await this.fetcher(current, {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
      });
      await setCookiesFromResponse(this.jar, response, current.toString());
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      current = new URL(location, current);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")) {
        method = "GET";
        body = undefined;
      }
    }
    throw new LibraryError("Too many redirects while contacting the HKU library service.");
  }
}

export class HkuLibraryClient {
  private readonly session: RequestSession;
  private readonly fetcher: typeof fetch;
  private root: HTMLElement | null = null;
  private currentUrl = LIBRARY_BOOKING_URL;

  constructor(options: LibraryClientOptions = {}) {
    this.fetcher = options.fetchImpl ?? fetch;
    this.session = new RequestSession(options.cookies ?? [], this.fetcher);
  }

  private async load(url = LIBRARY_BOOKING_URL): Promise<HTMLElement> {
    const response = await this.session.request(url);
    const html = await response.text();
    if (!response.ok || /name=["']username["']/iu.test(html) || response.url.includes("/hkulauth/")) {
      throw new LibraryAuthRequiredError(`The library page redirected to sign-in (${response.url}).`);
    }
    this.currentUrl = response.url || url;
    this.root = parse(html);
    return this.root;
  }

  private requireRoot(): HTMLElement {
    if (!this.root) throw new LibraryError("The library form has not been loaded.");
    return this.root;
  }

  private async postback(overrides: Record<string, string>): Promise<void> {
    const data = { ...hiddenFields(this.requireRoot()), ...overrides };
    const response = await this.session.request(this.currentUrl, {
      method: "POST",
      body: new URLSearchParams(data),
      headers: {
        Referer: this.currentUrl,
        Origin: LIBRARY_AUTH_ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const html = await response.text();
    if (!response.ok) {
      throw new LibraryError(`Library postback returned HTTP ${response.status}.`);
    }
    if (response.url.includes("/hkulauth/")) {
      throw new LibraryAuthRequiredError();
    }
    this.currentUrl = response.url || this.currentUrl;
    this.root = parse(html);
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.load();
      return Boolean(findGridTable(this.requireRoot()));
    } catch {
      return false;
    }
  }

  async locations(): Promise<LibraryOption[]> {
    await this.load();
    return selectOptions(this.requireRoot(), LIBRARY_SELECT);
  }

  async facilityTypes(locationNeedle: string): Promise<LibraryOption[]> {
    await this.load();
    const location = resolveOption(selectOptions(this.requireRoot(), LIBRARY_SELECT), locationNeedle, "location");
    await this.postback({
      __EVENTTARGET: LIBRARY_SELECT,
      __EVENTARGUMENT: "",
      [LIBRARY_SELECT]: location.value,
    });
    return selectOptions(this.requireRoot(), TYPE_SELECT);
  }

  async offeredDates(locationNeedle: string, typeNeedle: string): Promise<LibraryOption[]> {
    await this.load();
    const location = resolveOption(selectOptions(this.requireRoot(), LIBRARY_SELECT), locationNeedle, "location");
    await this.postback({
      __EVENTTARGET: LIBRARY_SELECT,
      __EVENTARGUMENT: "",
      [LIBRARY_SELECT]: location.value,
    });
    const facilityType = resolveOption(selectOptions(this.requireRoot(), TYPE_SELECT), typeNeedle, "facility type");
    await this.postback({
      __EVENTTARGET: TYPE_SELECT,
      __EVENTARGUMENT: "",
      [TYPE_SELECT]: facilityType.value,
    });
    return selectOptions(this.requireRoot(), VIEW_SELECT);
  }

  async grid(locationNeedle: string, typeNeedle: string, dateNeedle?: string): Promise<LibraryGrid> {
    await this.load();
    const location = resolveOption(selectOptions(this.requireRoot(), LIBRARY_SELECT), locationNeedle, "location");
    await this.postback({
      __EVENTTARGET: LIBRARY_SELECT,
      __EVENTARGUMENT: "",
      [LIBRARY_SELECT]: location.value,
    });
    const facilityType = resolveOption(selectOptions(this.requireRoot(), TYPE_SELECT), typeNeedle, "facility type");
    await this.postback({
      __EVENTTARGET: TYPE_SELECT,
      __EVENTARGUMENT: "",
      [TYPE_SELECT]: facilityType.value,
    });
    const dates = selectOptions(this.requireRoot(), VIEW_SELECT);
    if (!dates.length) throw new LibraryError("The library service returned no available dates.");
    const date = dateNeedle ? resolveOption(dates, dateNeedle, "date") : dates[0];
    await this.postback({
      __EVENTTARGET: "",
      __EVENTARGUMENT: "",
      [VIEW_SELECT]: date.value,
      [SEARCH_BUTTON]: "Search",
    });
    return parseLibraryGrid(this.requireRoot().toString(), this.currentUrl, {
      location: location.text,
      facilityType: facilityType.text,
      date: date.value,
    });
  }

  async rooms(options: {
    location?: string;
    facilityType?: string;
    date?: string;
    all?: boolean;
  } = {}): Promise<LibraryGrid[]> {
    const locations = await this.locations();
    const selectedLocations = options.location
      ? [resolveOption(locations, options.location, "location")]
      : locations;
    const grids: LibraryGrid[] = [];
    for (const location of selectedLocations) {
      const types = await this.facilityTypes(location.text);
      const selectedTypes = options.facilityType
        ? [resolveOption(types, options.facilityType, "facility type")]
        : types;
      for (const type of selectedTypes) {
        try {
          const grid = await this.grid(location.text, type.text, options.date);
          if (options.all || grid.rooms.some(room => room.availableSessions.length)) grids.push(grid);
        } catch (error) {
          if (error instanceof LibraryAuthRequiredError) throw error;
        }
      }
    }
    return grids;
  }

  async bookings(): Promise<LibraryBooking[]> {
    const response = await this.session.request(LIBRARY_MY_BOOKINGS_URL);
    const html = await response.text();
    if (!response.ok || response.url.includes("/hkulauth/")) throw new LibraryAuthRequiredError();
    return parseLibraryBookings(html);
  }

  async bookSlot(slotUrl: string, description = "", maxSteps = 6): Promise<LibraryBookResult> {
    const parsed = new URL(slotUrl);
    if (parsed.origin !== LIBRARY_AUTH_ORIGIN || !parsed.pathname.toLowerCase().endsWith("/newbooking.aspx")) {
      throw new LibraryError("Only NewBooking.aspx links from booking.lib.hku.hk can be submitted.");
    }
    const response = await this.session.request(parsed.toString());
    let html = await response.text();
    if (!response.ok || response.url.includes("/hkulauth/")) throw new LibraryAuthRequiredError();
    let root = parse(html);
    const sessionCode = parsed.searchParams.get("session") ?? "";
    if (!sessionCode) throw new LibraryError("The selected slot has no session code.");
    let prepared = formPayload(root, sessionCode);
    if (!prepared.matched) {
      throw new LibraryError("That slot is no longer offered; someone may have taken it.");
    }
    prepared.data[DESCRIPTION_FIELD] = description;
    prepared.data.__EVENTTARGET = "";
    prepared.data.__EVENTARGUMENT = "";
    prepared.data[SUBMIT_BUTTON] = "Submit";
    const steps = ["submit"];
    let current = parsed.toString();
    let currentResponse = await this.session.request(current, {
      method: "POST",
      body: new URLSearchParams(prepared.data),
      headers: {
        Referer: parsed.toString(),
        Origin: LIBRARY_AUTH_ORIGIN,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    html = await currentResponse.text();

    for (let index = 0; index < maxSteps; index += 1) {
      root = parse(html);
      const text = clean(root.text).toLowerCase();
      prepared = formPayload(root, sessionCode);
      prepared.data.__EVENTTARGET = "";
      prepared.data.__EVENTARGUMENT = "";
      if (EMAIL_MARKERS.some(marker => text.includes(marker))) {
        prepared.data[SKIP_EMAIL_BUTTON] = "Skip";
        steps.push("skip-email");
      } else if (CONFIRM_MARKERS.some(marker => text.includes(marker))) {
        prepared.data[YES_BUTTON] = "Yes";
        steps.push("confirm");
      } else if (RESULT_MARKERS.some(marker => text.includes(marker))) {
        steps.push("result");
        break;
      } else {
        steps.push("unknown");
        break;
      }
      current = currentResponse.url || current;
      currentResponse = await this.session.request(current, {
        method: "POST",
        body: new URLSearchParams(prepared.data),
        headers: {
          Referer: current,
          Origin: LIBRARY_AUTH_ORIGIN,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
      html = await currentResponse.text();
    }
    const finalRoot = parse(html);
    return {
      steps,
      url: currentResponse.url,
      text: clean(finalRoot.text).slice(0, 1500),
      bookings: parseLibraryBookings(html),
    };
  }
}
