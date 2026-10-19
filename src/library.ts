import { createHash } from "node:crypto";

import { defaultBrowserCookieProvider, type AuthOptions } from "./auth.js";
import { CdpError, cdpProfileDir, loginWithCdp } from "./cdp-login.js";
import { AuthError, CliError, UsageError } from "./errors.js";
import {
  bookingWasAccepted,
  buildBookingConfirmationSubmission,
  buildBookingSubmission,
  buildCancellationRequest,
  cancellationMatches,
  confirmationMatches,
  HKU_LIBRARY_BOOKING_ORIGIN,
  HKU_LIBRARY_PUBLIC_URL,
  parseBookingForm,
  parseBookingCancelTargets,
  parseBookingRecords,
  parseBookingUrl,
  parseHtmlForm,
  parseLibraryAvailabilityPage,
  parseLibraryFacilities,
  serializeHtmlForm,
  type BookingPlan,
  type BookingUrlTarget,
  type LibraryAvailableSlot,
  type LibraryBookingCancelTarget,
  type LibraryBookingRecord,
  type LibraryFacilitiesResult,
} from "./library-core.js";
import { deleteSecureState, readSecureState, writeSecureState, type SecureStateOptions } from "./secure-state.js";
import { trustSystemCertificates } from "./system-ca.js";
import { CookieJar, fetchWithCookies, parseCookieHeader, type WebCookie } from "./web-cookies.js";

const LIBRARY_STATE_NAME = "library-session";
const LIBRARY_LOGIN_URL = "https://booking.lib.hku.hk/FView.aspx?lib=3&ftype=21";
const LIBRARY_STATUS_URL = "https://booking.lib.hku.hk/Secure/FacilityStatusDate.aspx";
const LIBRARY_RECORDS_URL = "https://booking.lib.hku.hk/Secure/MyBookingRecord.aspx";

export interface LibrarySessionState {
  version: 1;
  cookies: WebCookie[];
  saved_at: number;
}

export interface LibrarySession {
  cookies: WebCookie[];
  source: "environment" | "cache" | "browser" | "login";
  from_cache: boolean;
}

export interface LibraryServiceOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  interactive?: boolean;
  noCache?: boolean;
  onBrowserOpened?: (url: string) => void;
}

export interface LibraryAvailabilityResult {
  location: string;
  facility_type: string;
  date: string;
  page_count: number;
  slots: LibraryAvailableSlot[];
}

export interface LibraryBookingResult {
  plan: BookingPlan;
  submitted: boolean;
  accepted: boolean;
  already_booked: boolean;
}

export interface LibraryCancellationQuery {
  date: string;
  start: string;
  end: string;
  location: string;
  floor?: string;
  facility: string;
}

export async function loadLibraryFacilities(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LibraryFacilitiesResult> {
  trustSystemCertificates();
  const [page, availability] = await Promise.all([
    fetchImpl(HKU_LIBRARY_PUBLIC_URL, { headers: { accept: "text/html" } }),
    fetchImpl("https://lib.hku.hk/js/availabilityFull.div", { headers: { accept: "text/html" } }),
  ]);
  if (!page.ok) throw new CliError("upstream", `HKU Libraries returned HTTP ${page.status}.`);
  return parseLibraryFacilities(await page.text(), availability.ok ? await availability.text() : "");
}

export async function getLibrarySession(options: LibraryServiceOptions = {}): Promise<LibrarySession> {
  trustSystemCertificates();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const rawCookie = options.env?.HKU_LIBRARY_COOKIE?.trim();
  if (rawCookie) {
    const cookies = parseCookieHeader(rawCookie).map(cookie => ({ ...cookie, domain: "booking.lib.hku.hk" }));
    if (await validateLibraryCookies(cookies, fetchImpl)) {
      return { cookies, source: "environment", from_cache: false };
    }
    throw new AuthError("HKU_LIBRARY_COOKIE does not authenticate with HKUL.", "Run `hku library login` instead.");
  }

  if (!options.noCache) {
    const cached = await readSecureState<LibrarySessionState>(LIBRARY_STATE_NAME, secureOptions(options));
    if (cached?.version === 1 && Array.isArray(cached.cookies) && await validateLibraryCookies(cached.cookies, fetchImpl)) {
      return { cookies: cached.cookies, source: "cache", from_cache: true };
    }
  }

  const browser = await browserLibraryCookies(options);
  if (browser.length && await validateLibraryCookies(browser, fetchImpl)) {
    await saveLibrarySession(browser, options);
    return { cookies: browser, source: "browser", from_cache: false };
  }

  if (!options.interactive) {
    throw new AuthError(
      "No authenticated HKUL library session was found.",
      "Run `hku library login` in a browser window, then retry.",
    );
  }

  const cookies = await loginThroughBrowser(options);
  await saveLibrarySession(cookies, options);
  return { cookies, source: "login", from_cache: false };
}

export async function getLibrarySessionStatus(options: LibraryServiceOptions = {}): Promise<{
  logged_in: boolean;
  source?: LibrarySession["source"];
  saved_at?: string;
  checked: boolean;
}> {
  trustSystemCertificates();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cached = await readSecureState<LibrarySessionState>(LIBRARY_STATE_NAME, secureOptions(options));
  if (!cached?.cookies?.length) return { logged_in: false, checked: false };
  return {
    logged_in: await validateLibraryCookies(cached.cookies, fetchImpl),
    source: "cache",
    saved_at: new Date(cached.saved_at).toISOString(),
    checked: true,
  };
}

export async function logoutLibrary(options: LibraryServiceOptions = {}): Promise<void> {
  await deleteSecureState(LIBRARY_STATE_NAME, secureOptions(options));
}

export async function findLibrarySlots(
  query: {
    location: string;
    facilityType: string;
    date?: string;
    floor?: string;
    room?: string;
    startTime?: string;
    endTime?: string;
  },
  options: LibraryServiceOptions = {},
): Promise<LibraryAvailabilityResult> {
  trustSystemCertificates();
  const date = query.date || hongKongDate();
  const session = await getLibrarySession(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const jar = new CookieJar(session.cookies);
  let page = await fetchWithCookies(LIBRARY_STATUS_URL, { headers: { accept: "text/html" } }, jar, fetchImpl);
  ensureBookingPage(page.url, page.response.status);
  let html = await page.response.text();

  let form = parseHtmlForm(html);
  const librarySelect = selectControl(form, /ddllibrary|location/u, "location");
  const locationValue = selectOptionValue(librarySelect, query.location);
  page = await postStatusForm(html, "ctl00$main$ddlLibrary", {
    "ctl00$main$ddlLibrary": locationValue,
    "ctl00$main$ddlType": "",
    "ctl00$main$ddlView": "",
  }, jar, fetchImpl);
  html = await page.response.text();

  form = parseHtmlForm(html);
  const typeSelect = selectControl(form, /ddltype|facility.*type/u, "facility type");
  const typeValue = selectOptionValue(typeSelect, query.facilityType);
  page = await postStatusForm(html, "ctl00$main$ddlType", {
    "ctl00$main$ddlLibrary": locationValue,
    "ctl00$main$ddlType": typeValue,
    "ctl00$main$ddlView": "",
  }, jar, fetchImpl);
  html = await page.response.text();

  form = parseHtmlForm(html);
  const dateSelect = selectControl(form, /ddlview|date/u, "date");
  const dateValue = selectOptionValue(dateSelect, date, true);
  page = await postStatusForm(html, "ctl00$main$btnGetResult", {
    "ctl00$main$ddlLibrary": locationValue,
    "ctl00$main$ddlType": typeValue,
    "ctl00$main$ddlView": dateValue,
    "ctl00$main$btnGetResult": "Search",
  }, jar, fetchImpl);
  html = await page.response.text();

  let current = parseLibraryAvailabilityPage(html, page.url);
  const slots = [...current.slots];
  for (let pageNumber = 2; pageNumber <= current.page_count; pageNumber += 1) {
    const pageForm = parseHtmlForm(html);
    const pageSelect = selectControl(pageForm, /ddlpage|page/u, "result page");
    const option = pageSelect.options.find(item => item.value === String(pageNumber));
    if (!option) break;
    page = await postStatusForm(html, pageSelect.name, {
      [pageSelect.name]: String(pageNumber),
    }, jar, fetchImpl);
    html = await page.response.text();
    current = parseLibraryAvailabilityPage(html, page.url);
    slots.push(...current.slots);
  }

  const matching = slots.filter(slot =>
    (!query.floor || slot.floor.toLowerCase() === query.floor.toLowerCase())
    && (!query.room || slot.room.toLowerCase() === query.room.toLowerCase())
    && (!query.startTime || slot.start_time === query.startTime)
    && (!query.endTime || slot.end_time === query.endTime));
  return {
    location: query.location,
    facility_type: query.facilityType,
    date,
    page_count: current.page_count,
    slots: [...new Map(matching.map(slot => [
      `${slot.floor}\0${slot.room}\0${slot.start_time}\0${slot.end_time}`,
      slot,
    ])).values()],
  };
}

export async function bookLibrarySpace(
  targetUrl: string,
  options: LibraryServiceOptions & {
    startTime?: string;
    endTime?: string;
    description?: string;
    email?: string;
    dryRun?: boolean;
  } = {},
): Promise<LibraryBookingResult> {
  trustSystemCertificates();
  const target = parseBookingUrl(targetUrl);
  const session = await getLibrarySession({ ...options, interactive: false });
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const jar = new CookieJar(session.cookies);
  const page = await fetchWithCookies(target.url, { headers: { accept: "text/html" } }, jar, fetchImpl);
  ensureBookingPage(page.url, page.response.status);
  const html = await page.response.text();
  const formPlan = parseBookingForm(html, target, {
    ...(options.startTime ? { startTime: options.startTime } : {}),
    ...(options.endTime ? { endTime: options.endTime } : {}),
  });
  const existing = (await readBookingRecords(jar, fetchImpl)).some(record =>
    sameBooking(record, formPlan.plan));
  if (options.dryRun) {
    return { plan: formPlan.plan, submitted: false, accepted: false, already_booked: existing };
  }
  if (existing) {
    return { plan: formPlan.plan, submitted: false, accepted: true, already_booked: true };
  }

  const first = buildBookingSubmission(formPlan, {
    ...(options.description ? { description: options.description } : {}),
    ...(options.email ? { email: options.email } : {}),
  });
  const action = safeBookingAction(formPlan.form.action, target.url);
  const firstResponse = await fetchWithCookies(action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html, */*; q=0.01",
      referer: target.url,
    },
    body: new URLSearchParams(first.values).toString(),
  }, jar, fetchImpl);
  ensureBookingPage(firstResponse.url, firstResponse.response.status);
  const confirmationHtml = await firstResponse.response.text();
  if (!confirmationMatches(confirmationHtml, formPlan.plan)) {
    if (bookingWasAccepted(confirmationHtml)) {
      return { plan: formPlan.plan, submitted: true, accepted: true, already_booked: false };
    }
    throw new CliError(
      "upstream",
      "HKUL did not return a confirmation matching the exact requested booking. Nothing was confirmed.",
    );
  }

  const confirmed = buildBookingConfirmationSubmission(first.values, confirmationHtml);
  let finalResponse: Awaited<ReturnType<typeof fetchWithCookies>>;
  try {
    finalResponse = await fetchWithCookies(firstResponse.url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html, */*; q=0.01",
        referer: target.url,
      },
      body: new URLSearchParams(confirmed.values).toString(),
    }, jar, fetchImpl);
  } catch (error) {
    if ((await readBookingRecords(jar, fetchImpl)).some(record => sameBooking(record, formPlan.plan))) {
      return { plan: formPlan.plan, submitted: true, accepted: true, already_booked: false };
    }
    throw error;
  }
  ensureBookingPage(finalResponse.url, finalResponse.response.status);
  const finalHtml = await finalResponse.response.text();
  const accepted = bookingWasAccepted(finalHtml);
  if (!accepted) {
    throw new CliError("upstream", "HKUL did not confirm the booking. Check My Booking Record before retrying.");
  }
  return { plan: formPlan.plan, submitted: true, accepted, already_booked: false };
}

export async function planLibraryCancellation(
  query: LibraryCancellationQuery,
  options: LibraryServiceOptions = {},
): Promise<LibraryBookingCancelTarget> {
  const session = await getLibrarySession(options);
  const jar = new CookieJar(session.cookies);
  const page = await fetchWithCookies(LIBRARY_RECORDS_URL, { headers: { accept: "text/html" } }, jar, options.fetchImpl);
  ensureBookingPage(page.url, page.response.status);
  return resolveCancellationTarget(await page.response.text(), query);
}

export async function cancelLibraryBooking(
  query: LibraryCancellationQuery,
  options: LibraryServiceOptions & { dryRun?: boolean } = {},
): Promise<{ cancelled: boolean; planned: LibraryBookingRecord; row_index: number }> {
  trustSystemCertificates();
  const session = await getLibrarySession(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const jar = new CookieJar(session.cookies);
  const page = await fetchWithCookies(LIBRARY_RECORDS_URL, { headers: { accept: "text/html" } }, jar, fetchImpl);
  ensureBookingPage(page.url, page.response.status);
  const html = await page.response.text();
  const target = resolveCancellationTarget(html, query);
  if (options.dryRun) {
    return { cancelled: false, planned: target.record, row_index: target.index };
  }

  const initial = buildCancellationRequest(html, target);
  const action = safeBookingAction(parseHtmlForm(html).action, LIBRARY_RECORDS_URL);
  const confirmation = await fetchWithCookies(action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      referer: LIBRARY_RECORDS_URL,
    },
    body: new URLSearchParams(initial).toString(),
  }, jar, fetchImpl);
  ensureBookingPage(confirmation.url, confirmation.response.status);
  const confirmationHtml = await confirmation.response.text();
  if (!cancellationMatches(confirmationHtml, target.record)) {
    throw new CliError("upstream", "HKUL did not return a cancellation confirmation matching the exact booking.");
  }

  const confirmationForm = parseHtmlForm(confirmationHtml);
  const yes = confirmationForm.controls.find(control =>
    control.id === "main_btnDeleteYes" && control.type === "submit" && /^yes$/iu.test(control.value));
  if (!yes) throw new CliError("upstream", "HKUL did not return the expected cancellation confirmation control.");
  const values = serializeHtmlForm(confirmationForm, { [yes.name]: "Yes" });
  const final = await fetchWithCookies(safeBookingAction(confirmationForm.action, confirmation.url), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      referer: confirmation.url,
    },
    body: new URLSearchParams(values).toString(),
  }, jar, fetchImpl);
  ensureBookingPage(final.url, final.response.status);
  await final.response.text();

  const remaining = await readBookingRecords(jar, fetchImpl);
  if (remaining.some(record => sameBooking(record, target.record))) {
    throw new CliError("upstream", "HKUL still lists the booking after cancellation. Check My Booking Record.");
  }
  return { cancelled: true, planned: target.record, row_index: target.index };
}

export async function listLibraryBookings(
  options: LibraryServiceOptions = {},
): Promise<ReturnType<typeof parseBookingRecords>> {
  trustSystemCertificates();
  const session = await getLibrarySession(options);
  const jar = new CookieJar(session.cookies);
  const page = await fetchWithCookies(LIBRARY_RECORDS_URL, { headers: { accept: "text/html" } }, jar, options.fetchImpl);
  ensureBookingPage(page.url, page.response.status);
  return parseBookingRecords(await page.response.text());
}

export async function validateLibraryCookies(
  cookies: readonly WebCookie[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  trustSystemCertificates();
  if (!cookies.length) return false;
  try {
    const page = await fetchWithCookies(LIBRARY_STATUS_URL, { headers: { accept: "text/html" } }, new CookieJar(cookies), fetchImpl);
    if (new URL(page.url).origin !== HKU_LIBRARY_BOOKING_ORIGIN) return false;
    const html = await page.response.text();
    return page.response.ok && /facilit(?:y|ies) booking system|facility status|new booking/iu.test(html);
  } catch {
    return false;
  }
}

async function browserLibraryCookies(options: LibraryServiceOptions): Promise<WebCookie[]> {
  const authOptions: AuthOptions = {
    homeDir: options.homeDir,
    env: options.env,
    platform: options.platform,
    fetch: options.fetchImpl,
  };
  try {
    const values = await defaultBrowserCookieProvider(LIBRARY_STATUS_URL, authOptions);
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

async function loginThroughBrowser(options: LibraryServiceOptions): Promise<WebCookie[]> {
  let validated: WebCookie[] | null = null;
  let lastSignature = "";
  try {
    const result = await loginWithCdp({
      url: LIBRARY_LOGIN_URL,
      headless: false,
      homeDir: options.homeDir,
      env: options.env,
      platform: options.platform,
      profileDir: cdpProfileDir(options.homeDir),
      onOpened: () => options.onBrowserOpened?.(LIBRARY_LOGIN_URL),
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
        if (await validateLibraryCookies(stateCookies, options.fetchImpl ?? globalThis.fetch)) {
          validated = stateCookies;
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

async function saveLibrarySession(cookies: WebCookie[], options: LibraryServiceOptions): Promise<void> {
  await writeSecureState<LibrarySessionState>(
    LIBRARY_STATE_NAME,
    { version: 1, cookies, saved_at: Date.now() },
    secureOptions(options),
  );
}

async function readBookingRecords(
  jar: CookieJar,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<LibraryBookingRecord[]> {
  const page = await fetchWithCookies(LIBRARY_RECORDS_URL, { headers: { accept: "text/html" } }, jar, fetchImpl);
  ensureBookingPage(page.url, page.response.status);
  return parseBookingRecords(await page.response.text());
}

function resolveCancellationTarget(
  html: string,
  query: LibraryCancellationQuery,
): LibraryBookingCancelTarget {
  const normalized = (value?: string) => value?.trim().toLowerCase() || "";
  const matches = parseBookingCancelTargets(html).filter(({ record }) =>
    record.date === query.date
    && record.start === query.start
    && record.end === query.end
    && normalized(record.location) === normalized(query.location)
    && (!query.floor || normalized(record.floor) === normalized(query.floor))
    && normalized(record.facility) === normalized(query.facility));
  if (matches.length !== 1) {
    throw new UsageError(
      matches.length
        ? "Multiple HKUL bookings match the cancellation target."
        : "No exact HKUL booking matches the cancellation target.",
      "Run `hku library bookings` and supply the exact date, start, end, location, floor, and room.",
    );
  }
  return matches[0];
}

function sameBooking(record: LibraryBookingRecord, wanted: BookingPlan | LibraryBookingRecord): boolean {
  const normalized = (value?: string) => value?.trim().toLowerCase() || "";
  const start = "start_time" in wanted ? wanted.start_time : wanted.start;
  const end = "end_time" in wanted ? wanted.end_time : wanted.end;
  const facility = "facility" in wanted ? wanted.facility : undefined;
  return record.date === wanted.date
    && record.start === start
    && record.end === end
    && normalized(record.location) === normalized(wanted.location)
    && normalized(record.floor) === normalized(wanted.floor)
    && normalized(record.facility) === normalized(facility)
    && normalized(record.status) === "booked";
}

function secureOptions(options: LibraryServiceOptions): SecureStateOptions {
  return { ...(options.homeDir ? { homeDir: options.homeDir } : {}) };
}

function ensureBookingPage(url: string, status: number): void {
  if (status >= 400) throw new CliError("upstream", `HKUL booking system returned HTTP ${status}.`);
  const parsed = new URL(url);
  if (parsed.origin !== HKU_LIBRARY_BOOKING_ORIGIN) {
    throw new AuthError("The HKUL booking session needs sign-in.", "Run `hku library login` and complete SSO.");
  }
}

async function postStatusForm(
  html: string,
  eventTarget: string,
  overrides: Record<string, string>,
  jar: CookieJar,
  fetchImpl: typeof fetch,
): Promise<Awaited<ReturnType<typeof fetchWithCookies>>> {
  const form = parseHtmlForm(html);
  const action = safeBookingAction(form.action, LIBRARY_STATUS_URL);
  const values = serializeHtmlForm(form, {
    ...overrides,
    __EVENTTARGET: eventTarget,
    __EVENTARGUMENT: "",
    __LASTFOCUS: "",
  });
  const response = await fetchWithCookies(action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html",
      referer: LIBRARY_STATUS_URL,
    },
    body: new URLSearchParams(values).toString(),
  }, jar, fetchImpl);
  ensureBookingPage(response.url, response.response.status);
  return response;
}

function selectControl(
  form: ReturnType<typeof parseHtmlForm>,
  pattern: RegExp,
  label: string,
): ReturnType<typeof parseHtmlForm>["controls"][number] {
  const matches = form.controls.filter(control =>
    control.tag === "select" && pattern.test(`${control.id} ${control.name}`.toLowerCase()));
  if (matches.length !== 1) {
    throw new UsageError(`The HKUL ${label} selector was not uniquely available.`);
  }
  return matches[0];
}

function selectOptionValue(
  control: ReturnType<typeof parseHtmlForm>["controls"][number],
  wanted: string,
  dateMode = false,
): string {
  const normalized = wanted.trim().toLowerCase();
  const matches = control.options.filter(option =>
    dateMode ? option.label.trim().toLowerCase().startsWith(normalized) : option.label.trim().toLowerCase() === normalized);
  if (matches.length !== 1) {
    throw new UsageError(
      `The HKUL option '${wanted}' was ${matches.length ? "ambiguous" : "not available"}.`,
      `Choose from: ${control.options.map(option => option.label).filter(label => !/^-\s*Please Select/u.test(label)).join(", ")}`,
    );
  }
  return matches[0].value;
}

function hongKongDate(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function safeBookingAction(action: string, pageUrl: string): string {
  const url = new URL(action || pageUrl, pageUrl);
  if (url.origin !== HKU_LIBRARY_BOOKING_ORIGIN) {
    throw new UsageError("The HKUL booking form points outside the official booking site.");
  }
  return url.toString();
}
