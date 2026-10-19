import { createHash } from "node:crypto";

import { parse } from "node-html-parser";

import { defaultBrowserCookieProvider, type AuthOptions } from "./auth.js";
import { CdpError, cdpProfileDir, loginWithCdp } from "./cdp-login.js";
import { AuthError, CliError } from "./errors.js";
import {
  parseCseActivities,
  parseCseBookingReceipt,
  parseCseCalendar,
  resolveCseActivity,
  type CseActivity,
  type CseBookingPlan,
  type CseCalendar,
  type CseSlot,
  type CseVenue,
} from "./cse-core.js";
import { deleteSecureState, readSecureState, writeSecureState, type SecureStateOptions } from "./secure-state.js";
import { trustSystemCertificates } from "./system-ca.js";
import { CookieJar, fetchWithCookies, parseCookieHeader, type WebCookie } from "./web-cookies.js";

export const CSE_BOOKING_HOME = "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Main/showModule";
export const CSE_MAIN_URL = "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Main/main?usertype=1";
export const CSE_MENU_URL = "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Main/menu";
export const CSE_ACTIVITY_LIST_URL = "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Booking/showActivityList1";
export const CSE_CALENDAR_URL = "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Booking/displayCalendar1";
export const CSE_BOOK_URL = "https://bs.cse.hku.hk/ihpbooking/servlet/IHP_Booking/booking1";
const CSE_STATE_NAME = "cse-session";
const CSE_ORIGIN = "https://bs.cse.hku.hk";

export interface CseSessionState {
  version: 1;
  cookies: WebCookie[];
  saved_at: number;
}

export interface CseSession {
  cookies: WebCookie[];
  source: "environment" | "cache" | "browser" | "login";
}

export interface CseServiceOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  interactive?: boolean;
  noCache?: boolean;
  onBrowserOpened?: (url: string) => void;
}

export interface CsePortalLink {
  text: string;
  url: string;
}

export interface CsePortalPage {
  title: string;
  url: string;
  text: string;
  links: CsePortalLink[];
}

export interface CseAvailabilityResult {
  activity_code: string;
  activity: string;
  date: string;
  venues: CseVenue[];
  slots: CseSlot[];
}

export interface CseBookingInput {
  activity: string;
  date: string;
  venue?: string;
  room: string;
  start: string;
}

export interface CseBookingResult {
  plan: CseBookingPlan;
  submitted: boolean;
  success: boolean;
  reference_number?: string;
  message: string;
}

export async function getCseSession(options: CseServiceOptions = {}): Promise<CseSession> {
  trustSystemCertificates();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const rawCookie = options.env?.HKU_CSE_COOKIE?.trim();
  if (rawCookie) {
    const cookies = parseCookieHeader(rawCookie).map(cookie => ({ ...cookie, domain: "bs.cse.hku.hk" }));
    const validated = await capturedCseCookies(cookies, fetchImpl);
    if (validated) {
      await saveCseSession(validated, options);
      return { cookies: validated, source: "environment" };
    }
    throw new AuthError("HKU_CSE_COOKIE does not authenticate with CSE Sports Booking.", "Run `hku facilities cse login`.");
  }

  if (!options.noCache) {
    const cached = await readSecureState<CseSessionState>(CSE_STATE_NAME, secureOptions(options));
    if (cached?.version === 1 && Array.isArray(cached.cookies)) {
      const validated = await capturedCseCookies(cached.cookies, fetchImpl);
      if (validated) {
        await saveCseSession(validated, options);
        return { cookies: validated, source: "cache" };
      }
    }
  }

  const shared = await sharedHkuServiceCookies(options);
  const sharedValidated = shared.length ? await capturedCseCookies(shared, fetchImpl) : null;
  if (sharedValidated) {
    await saveCseSession(sharedValidated, options);
    return { cookies: sharedValidated, source: "cache" };
  }

  const browser = await browserCseCookies(options);
  const browserValidated = browser.length ? await capturedCseCookies(browser, fetchImpl) : null;
  if (browserValidated) {
    await saveCseSession(browserValidated, options);
    return { cookies: browserValidated, source: "browser" };
  }

  if (options.interactive) {
    const persisted = await loginThroughBrowser(options, { headless: true, timeoutMs: 8_000 }).catch(() => []);
    const persistedValidated = persisted.length ? await capturedCseCookies(persisted, fetchImpl) : null;
    if (persistedValidated) {
      await saveCseSession(persistedValidated, options);
      return { cookies: persistedValidated, source: "browser" };
    }
  }

  if (!options.interactive) {
    throw new AuthError(
      "No authenticated CSE Sports Booking session was found.",
      "Run `hku facilities cse login` in a browser window, then retry.",
    );
  }
  const cookies = await loginThroughBrowser(options);
  await saveCseSession(cookies, options);
  return { cookies, source: "login" };
}

export async function getCseSessionStatus(options: CseServiceOptions = {}): Promise<{
  logged_in: boolean;
  source?: CseSession["source"];
  saved_at?: string;
  checked: boolean;
}> {
  const cached = await readSecureState<CseSessionState>(CSE_STATE_NAME, secureOptions(options));
  if (!cached?.cookies?.length) return { logged_in: false, checked: false };
  return {
    logged_in: await validateCseCookies(cached.cookies, options.fetchImpl ?? globalThis.fetch),
    source: "cache",
    saved_at: new Date(cached.saved_at).toISOString(),
    checked: true,
  };
}

export async function logoutCse(options: CseServiceOptions = {}): Promise<void> {
  await deleteSecureState(CSE_STATE_NAME, secureOptions(options));
}

export async function loadCsePortal(options: CseServiceOptions = {}): Promise<CsePortalPage> {
  const session = await getCseSession(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const jar = new CookieJar(session.cookies);
  const page = await fetchWithCookies(
    CSE_BOOKING_HOME,
    { headers: { accept: "text/html" } },
    jar,
    fetchImpl,
  );
  ensureCsePage(page.url, page.response.status);
  if (/EService\/loginForm_cas/iu.test(page.url)) {
    const [main, menu] = await Promise.all([
      fetchWithCookies(CSE_MAIN_URL, { headers: { accept: "text/html" } }, jar, fetchImpl),
      fetchWithCookies(CSE_MENU_URL, { headers: { accept: "text/html" } }, jar, fetchImpl),
    ]);
    ensureCsePage(main.url, main.response.status);
    ensureCsePage(menu.url, menu.response.status);
    const mainPage = parseCsePage(await main.response.text(), main.url);
    const menuPage = parseCsePage(await menu.response.text(), menu.url);
    return {
      ...mainPage,
      title: mainPage.title || "CSE Booking System",
      links: [...new Map([...menuPage.links, ...mainPage.links].map(link => [link.url, link])).values()],
    };
  }
  const landing = parseCsePage(await page.response.text(), page.url);
  if (landing.text.length >= 200) return landing;
  const child = landing.links.find(link => /\/ihpbooking\//iu.test(link.url) && !/logout|signout/iu.test(link.url));
  if (!child) return landing;
  const nested = await fetchWithCookies(child.url, { headers: { accept: "text/html" } }, jar, fetchImpl);
  ensureCsePage(nested.url, nested.response.status);
  const parsed = parseCsePage(await nested.response.text(), nested.url);
  return {
    ...parsed,
    title: parsed.title || landing.title,
    links: [...new Map([...parsed.links, ...landing.links].map(link => [link.url, link])).values()],
  };
}

export async function listCseActivities(
  options: CseServiceOptions = {},
): Promise<CseActivity[]> {
  trustSystemCertificates();
  const html = await publicCseHtml(CSE_ACTIVITY_LIST_URL, options.fetchImpl ?? globalThis.fetch);
  return parseCseActivities(html);
}

export async function findCseSlots(
  query: { activity: string; date: string; venue?: string; availableOnly?: boolean },
  options: CseServiceOptions = {},
): Promise<CseAvailabilityResult> {
  trustSystemCertificates();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const activities = await listCseActivities({ fetchImpl });
  const activity = resolveCseActivity(activities, query.activity);
  const today = hongKongDate(new Date());
  const first = await cseCalendarPost(activity, today, undefined, fetchImpl);
  if (!first.venues.length) {
    return {
      activity_code: activity.code,
      activity: activity.name,
      date: query.date,
      venues: [],
      slots: [],
    };
  }
  const wantedVenue = query.venue?.trim().toLowerCase();
  const selectedVenues = wantedVenue
    ? first.venues.filter(venue => venue.code.toLowerCase() === wantedVenue || normalize(venue.name) === normalize(query.venue!))
    : first.venues;
  if (!selectedVenues.length) {
    throw new CliError(
      "usage",
      `CSE venue '${query.venue}' was not found for ${activity.name}.`,
      `Choose from: ${first.venues.map(venue => venue.name).join(", ")}`,
    );
  }
  const calendars: CseCalendar[] = [];
  for (const venue of selectedVenues) {
    const calendar = query.date === today && venue.code === first.venues[0]?.code
      ? first
      : await cseCalendarPost(activity, query.date, venue, fetchImpl);
    calendars.push({
      ...calendar,
      slots: calendar.slots.map(slot => ({
        ...slot,
        venue_code: venue.code,
        venue: venue.name,
      })),
    });
  }
  const slots = calendars.flatMap(calendar => calendar.slots)
    .filter(slot => query.availableOnly === false || slot.available);
  return {
    activity_code: activity.code,
    activity: activity.name,
    date: query.date,
    venues: selectedVenues,
    slots: [...new Map(slots.map(slot => [
      `${slot.venue_code}\0${slot.room_code}\0${slot.start_time}\0${slot.end_time}`,
      slot,
    ])).values()],
  };
}

export async function bookCseSpace(
  input: CseBookingInput,
  options: CseServiceOptions & { dryRun?: boolean } = {},
): Promise<CseBookingResult> {
  trustSystemCertificates();
  const available = await findCseSlots({
    activity: input.activity,
    date: input.date,
    venue: input.venue,
    availableOnly: true,
  }, { fetchImpl: options.fetchImpl });
  const matches = available.slots.filter(slot =>
    normalize(slot.room) === normalize(input.room)
    || normalize(slot.room_code) === normalize(input.room))
    .filter(slot => slot.start_time === input.start);
  if (matches.length !== 1) {
    throw new CliError(
      "usage",
      matches.length
        ? "More than one CSE slot matches the exact activity, venue, room and start time."
        : "That exact CSE slot is not currently available.",
      "Run `hku facilities cse slots` again and use the exact venue, room and start time.",
    );
  }
  const slot = matches[0]!;
  const warnings = [
    "CSE bookings can have no-show and access consequences. Gym users should cancel at least one hour before the session.",
    "A real submission requires an authenticated CSE Sports Booking session.",
  ];
  const plan: CseBookingPlan = {
    service: "cse",
    activity_code: available.activity_code,
    activity: available.activity,
    date: input.date,
    venue_code: slot.venue_code,
    venue: slot.venue,
    room_code: slot.room_code,
    room: slot.room,
    time: slot.time,
    start_time: slot.start_time,
    end_time: slot.end_time,
    warnings,
  };
  if (options.dryRun !== false) {
    return { plan, submitted: false, success: false, message: "Dry run: nothing was submitted to CSE." };
  }

  const session = await getCseSession({ ...options, interactive: false });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const jar = new CookieJar(session.cookies);
  const response = await fetchWithCookies(CSE_BOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      referer: CSE_CALENDAR_URL,
    },
    body: new URLSearchParams({
      roomcode: slot.room_code,
      time: slot.time,
      bookdate: displayCseDate(input.date),
      fac_type_code: slot.venue_code,
      centre_code: slot.venue_code,
      act_type_code: available.activity_code,
      activity_name: available.activity,
    }).toString(),
  }, jar, fetchImpl);
  ensureCsePage(response.url, response.response.status);
  const receipt = parseCseBookingReceipt(await response.response.text());
  return { plan, submitted: true, ...receipt };
}

export function parseCsePage(html: string, pageUrl: string): CsePortalPage {
  const root = parse(html);
  const title = clean(root.querySelector("title")?.textContent) || "CSE Sports Booking";
  const bodyText = clean(root.querySelector("body")?.textContent).slice(0, 8_000);
  const linkNodes = [
    ...root.querySelectorAll("a[href]"),
    ...root.querySelectorAll("frame[src]"),
    ...root.querySelectorAll("iframe[src]"),
  ];
  const links = linkNodes.flatMap(node => {
    const text = clean(node.textContent)
      || clean(node.getAttribute("title"))
      || clean(node.getAttribute("name"))
      || "Embedded booking page";
    const href = (node.getAttribute("href") ?? node.getAttribute("src"))?.trim();
    if (!text || !href || href === "#" || /^javascript:/iu.test(href)) return [];
    try {
      const url = new URL(href, pageUrl);
      if (url.origin !== CSE_ORIGIN && !/\.hku\.hk$/iu.test(url.hostname)) return [];
      return [{ text, url: url.toString() }];
    } catch {
      return [];
    }
  });
  return {
    title,
    url: pageUrl,
    text: bodyText,
    links: [...new Map(links.map(link => [`${link.text}\0${link.url}`, link])).values()],
  };
}

export async function validateCseCookies(
  cookies: readonly WebCookie[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  return Boolean(await capturedCseCookies(cookies, fetchImpl));
}

async function capturedCseCookies(
  cookies: readonly WebCookie[],
  fetchImpl: typeof fetch,
): Promise<WebCookie[] | null> {
  trustSystemCertificates();
  if (!cookies.length) return null;
  try {
    const jar = new CookieJar(cookies);
    const page = await fetchWithCookies(CSE_BOOKING_HOME, { headers: { accept: "text/html" } }, jar, fetchImpl);
    if (new URL(page.url).origin !== CSE_ORIGIN) return null;
    const html = await page.response.text();
    if (!page.response.ok) return null;
    if (/EService\/loginForm_cas/iu.test(page.url) && /IHP_Main\/main/iu.test(html)) {
      const main = await fetchWithCookies(CSE_MAIN_URL, { headers: { accept: "text/html" } }, jar, fetchImpl);
      const mainHtml = await main.response.text();
      if (!main.response.ok || /Invalid Session|Session is timeout/iu.test(mainHtml)) return null;
    } else if (/Invalid Session|Session is timeout/iu.test(html)) {
      return null;
    }
    return jar.serialize();
  } catch {
    return null;
  }
}

async function browserCseCookies(options: CseServiceOptions): Promise<WebCookie[]> {
  const authOptions: AuthOptions = {
    homeDir: options.homeDir,
    env: options.env,
    platform: options.platform,
    fetch: options.fetchImpl,
  };
  try {
    const values = await defaultBrowserCookieProvider(CSE_BOOKING_HOME, authOptions);
    return values
      .filter(cookie => cookie.domain && /(?:^|\.)hku\.hk$/iu.test(cookie.domain))
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
      }));
  } catch {
    return [];
  }
}

async function loginThroughBrowser(
  options: CseServiceOptions,
  mode: { headless?: boolean; timeoutMs?: number } = {},
): Promise<WebCookie[]> {
  let validated: WebCookie[] | null = null;
  let lastSignature = "";
  try {
    const result = await loginWithCdp({
      url: CSE_BOOKING_HOME,
      headless: Boolean(mode.headless),
      ...(mode.timeoutMs ? { timeoutMs: mode.timeoutMs } : {}),
      homeDir: options.homeDir,
      env: options.env,
      platform: options.platform,
      profileDir: cdpProfileDir(options.homeDir),
      onOpened: mode.headless ? undefined : () => options.onBrowserOpened?.(CSE_BOOKING_HOME),
      isDone: async cookies => {
        const stateCookies = cookies
          .filter(cookie => /(?:^|\.)hku\.hk$/iu.test(cookie.domain))
          .map(cookie => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
            ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
          }));
        const signature = createHash("sha256")
          .update(stateCookies.map(cookie => `${cookie.domain}|${cookie.name}|${cookie.value}`).join("\n"))
          .digest("hex");
        if (signature === lastSignature) return Boolean(validated);
        lastSignature = signature;
        const authenticated = await capturedCseCookies(stateCookies, options.fetchImpl ?? globalThis.fetch);
        if (authenticated) {
          validated = authenticated;
          return true;
        }
        return false;
      },
    });
    if (validated) return validated;
    return result.cookies
      .filter(cookie => /(?:^|\.)hku\.hk$/iu.test(cookie.domain))
      .map(cookie => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        ...(cookie.secure === undefined ? {} : { secure: cookie.secure }),
        ...(cookie.httpOnly === undefined ? {} : { httpOnly: cookie.httpOnly }),
      }));
  } catch (error) {
    if (error instanceof CdpError) throw new AuthError(error.message, error.hint);
    throw error;
  }
}

async function saveCseSession(cookies: WebCookie[], options: CseServiceOptions): Promise<void> {
  await writeSecureState<CseSessionState>(
    CSE_STATE_NAME,
    { version: 1, cookies, saved_at: Date.now() },
    secureOptions(options),
  );
}

async function sharedHkuServiceCookies(options: CseServiceOptions): Promise<WebCookie[]> {
  const states = await Promise.all([
    readSecureState<{ version?: number; cookies?: WebCookie[] }>("library-session", secureOptions(options)),
    readSecureState<{ version?: number; cookies?: WebCookie[] }>("hkufbs-session", secureOptions(options)),
  ]);
  return [...new Map(states
    .flatMap(state => state?.version === 1 && Array.isArray(state.cookies) ? state.cookies : [])
    .filter(cookie => /(?:^|\.)hku\.hk$/iu.test(cookie.domain ?? ""))
    .map(cookie => [`${cookie.domain}\0${cookie.path ?? "/"}\0${cookie.name}`, cookie])).values()];
}

function ensureCsePage(url: string, status: number): void {
  if (status >= 400) throw new CliError("upstream", `CSE Sports Booking returned HTTP ${status}.`);
  if (new URL(url).origin !== CSE_ORIGIN) {
    throw new AuthError("The CSE Sports Booking session needs sign-in.", "Run `hku facilities cse login`.");
  }
}

function secureOptions(options: CseServiceOptions): SecureStateOptions {
  return { ...(options.homeDir ? { homeDir: options.homeDir } : {}) };
}

async function publicCseHtml(url: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(url, { headers: { accept: "text/html" } });
  if (!response.ok) throw new CliError("upstream", `CSE Sports Booking returned HTTP ${response.status}.`);
  return response.text();
}

async function cseCalendarPost(
  activity: CseActivity,
  date: string,
  venue: CseVenue | undefined,
  fetchImpl: typeof fetch,
): Promise<CseCalendar> {
  const values = new URLSearchParams({ act_type_code: activity.code });
  if (venue) {
    values.set("activity_name", activity.name);
    values.set("mydate", displayCseDate(date));
    values.set("fac_type_code", venue.code);
    values.set("centre_code", venue.code);
    values.set("ft_code_centre_code", venue.code);
  }
  const response = await fetchImpl(CSE_CALENDAR_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      referer: CSE_ACTIVITY_LIST_URL,
    },
    body: values.toString(),
  });
  const html = await response.text();
  if (!response.ok) {
    throw new CliError("upstream", `CSE Sports Booking returned HTTP ${response.status} for ${activity.name}.`);
  }
  if (/No facility is found/iu.test(html)) {
    return { activity_code: activity.code, activity: activity.name, date, venues: [], rooms: [], slots: [] };
  }
  if (!/CSE Booking System/iu.test(html)) {
    throw new CliError("upstream", `CSE Sports Booking returned an unexpected page for ${activity.name}.`);
  }
  return parseCseCalendar(html);
}

function displayCseDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) throw new CliError("usage", "CSE dates must use YYYY-MM-DD.");
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function hongKongDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/gu, " ").trim();
}
