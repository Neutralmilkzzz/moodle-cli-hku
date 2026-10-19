import { createHash } from "node:crypto";

import { defaultBrowserCookieProvider, type AuthOptions } from "./auth.js";
import { CdpError, cdpProfileDir, loginWithCdp } from "./cdp-login.js";
import { AuthError, CliError, UsageError } from "./errors.js";
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
  type HkufbsAttribute,
  type HkufbsCatalog,
  type HkufbsOpening,
  type HkufbsReservationPlan,
  type HkufbsSearchQuery,
} from "./hkufbs-core.js";
import { deleteSecureState, readSecureState, writeSecureState, type SecureStateOptions } from "./secure-state.js";
import { trustSystemCertificates } from "./system-ca.js";
import { CookieJar, fetchWithCookies, parseCookieHeader, type WebCookie } from "./web-cookies.js";

export const HKUFBS_BASE_URL = "https://hkufbs.hku.hk/fbs/centralbook/book/Web/";
export const HKUFBS_SEARCH_URL = `${HKUFBS_BASE_URL}search-availability.php`;
export const HKUFBS_API_URL = `${HKUFBS_BASE_URL}api/reservation.php`;

const HKUFBS_STATE_NAME = "hkufbs-session";

export interface HkufbsSessionState {
  version: 1;
  cookies: WebCookie[];
  saved_at: number;
}

export interface HkufbsSession {
  cookies: WebCookie[];
  source: "environment" | "cache" | "browser" | "login";
  from_cache: boolean;
}

export interface HkufbsServiceOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  fetchImpl?: typeof fetch;
  interactive?: boolean;
  noCache?: boolean;
  onBrowserOpened?: (url: string) => void;
}

export interface HkufbsAvailabilityResult {
  date: string;
  end_date: string;
  resource: string | null;
  openings: HkufbsOpening[];
}

export interface HkufbsBookingOptions extends HkufbsServiceOptions {
  destinationEmail?: string;
  dryRun?: boolean;
}

export interface HkufbsBookingInput {
  resource: string;
  date: string;
  start: string;
  end: string;
  contact?: string;
  uid?: string;
  title?: string;
  description?: string;
  attributes?: Record<string, string>;
  acceptPolicy?: boolean;
  dryRun?: boolean;
}

export interface HkufbsBookingResult {
  plan: HkufbsReservationPlan;
  submitted: boolean;
  success: boolean;
  reference_number?: string;
  requires_approval?: boolean;
  errors: string[];
}

export async function getHkufbsSession(options: HkufbsServiceOptions = {}): Promise<HkufbsSession> {
  trustSystemCertificates();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const rawCookie = options.env?.HKU_FBS_COOKIE?.trim();
  if (rawCookie) {
    const cookies = parseCookieHeader(rawCookie).map(cookie => ({ ...cookie, domain: "hkufbs.hku.hk" }));
    if (await validateHkufbsCookies(cookies, fetchImpl)) {
      return { cookies, source: "environment", from_cache: false };
    }
    throw new AuthError("HKU_FBS_COOKIE does not authenticate with HKUFBS.", "Run `hku facilities hkufbs login`.");
  }

  if (!options.noCache) {
    const cached = await readSecureState<HkufbsSessionState>(HKUFBS_STATE_NAME, secureOptions(options));
    if (cached?.version === 1 && Array.isArray(cached.cookies) && await validateHkufbsCookies(cached.cookies, fetchImpl)) {
      return { cookies: cached.cookies, source: "cache", from_cache: true };
    }
  }

  const browser = await browserHkufbsCookies(options);
  if (browser.length && await validateHkufbsCookies(browser, fetchImpl)) {
    await saveHkufbsSession(browser, options);
    return { cookies: browser, source: "browser", from_cache: false };
  }

  if (options.interactive) {
    const persisted = await loginThroughBrowser(options, { headless: true, timeoutMs: 8_000 }).catch(() => []);
    if (persisted.length && await validateHkufbsCookies(persisted, fetchImpl)) {
      await saveHkufbsSession(persisted, options);
      return { cookies: persisted, source: "browser", from_cache: false };
    }
  }

  if (!options.interactive) {
    throw new AuthError(
      "No authenticated HKUFBS session was found.",
      "Run `hku facilities hkufbs login` in a browser window, then retry.",
    );
  }
  const cookies = await loginThroughBrowser(options);
  await saveHkufbsSession(cookies, options);
  return { cookies, source: "login", from_cache: false };
}

export async function getHkufbsSessionStatus(options: HkufbsServiceOptions = {}): Promise<{
  logged_in: boolean;
  source?: HkufbsSession["source"];
  saved_at?: string;
  checked: boolean;
}> {
  trustSystemCertificates();
  const cached = await readSecureState<HkufbsSessionState>(HKUFBS_STATE_NAME, secureOptions(options));
  if (!cached?.cookies?.length) return { logged_in: false, checked: false };
  return {
    logged_in: await validateHkufbsCookies(cached.cookies, options.fetchImpl ?? globalThis.fetch),
    source: "cache",
    saved_at: new Date(cached.saved_at).toISOString(),
    checked: true,
  };
}

export async function logoutHkufbs(options: HkufbsServiceOptions = {}): Promise<void> {
  await deleteSecureState(HKUFBS_STATE_NAME, secureOptions(options));
}

export async function loadHkufbsCatalog(
  options: HkufbsServiceOptions = {},
): Promise<{ catalog: HkufbsCatalog; session: HkufbsSession }> {
  trustSystemCertificates();
  const session = await getHkufbsSession(options);
  const page = await fetchWithCookies(
    HKUFBS_SEARCH_URL,
    { headers: { accept: "text/html" } },
    new CookieJar(session.cookies),
    options.fetchImpl ?? globalThis.fetch,
  );
  ensureHkufbsPage(page.url, page.response.status);
  return { catalog: parseHkufbsCatalog(await page.response.text(), page.url), session };
}

export async function findHkufbsSlots(
  query: HkufbsSearchQuery,
  options: HkufbsServiceOptions = {},
): Promise<HkufbsAvailabilityResult> {
  trustSystemCertificates();
  const session = await getHkufbsSession(options);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const jar = new CookieJar(session.cookies);
  const page = await fetchWithCookies(HKUFBS_SEARCH_URL, { headers: { accept: "text/html" } }, jar, fetchImpl);
  ensureHkufbsPage(page.url, page.response.status);
  const catalog = parseHkufbsCatalog(await page.response.text(), page.url);
  const body = buildHkufbsSearchBody(catalog, query);
  const response = await fetchWithCookies(catalog.action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      accept: "text/html",
      referer: HKUFBS_SEARCH_URL,
    },
    body: body.toString(),
  }, jar, fetchImpl);
  ensureHkufbsPage(response.url, response.response.status);
  const html = await response.response.text();
  const openings = parseHkufbsOpenings(html, HKUFBS_SEARCH_URL, catalog);
  return {
    date: query.date,
    end_date: query.endDate ?? query.date,
    resource: query.resource ?? null,
    openings,
  };
}

export async function bookHkufbsSpace(
  input: HkufbsBookingInput,
  options: HkufbsBookingOptions = {},
): Promise<HkufbsBookingResult> {
  trustSystemCertificates();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const session = await getHkufbsSession({ ...options, interactive: false });
  const jar = new CookieJar(session.cookies);
  const catalogPage = await fetchWithCookies(HKUFBS_SEARCH_URL, { headers: { accept: "text/html" } }, jar, fetchImpl);
  ensureHkufbsPage(catalogPage.url, catalogPage.response.status);
  const catalog = parseHkufbsCatalog(await catalogPage.response.text(), catalogPage.url);
  const resource = resolveHkufbsResource(catalog, input.resource);
  const availability = await findHkufbsSlots({
    date: input.date,
    resource: resource.id,
    start: input.start,
    end: input.end,
  }, { ...options, fetchImpl, interactive: false });
  const exact = availability.openings.filter(opening =>
    opening.resource_id === resource.id
    && opening.date === input.date
    && opening.start_time === input.start
    && opening.end_time === input.end);
  if (exact.length !== 1) {
    throw new UsageError(
      exact.length
        ? "More than one HKUFBS opening matches the exact reservation."
        : "That exact HKUFBS opening is no longer available.",
      "Run `hku facilities hkufbs slots` again and use the exact resource id, date, start and end.",
    );
  }

  const reservationPage = await fetchWithCookies(exact[0]!.reservation_url, { headers: { accept: "text/html" } }, jar, fetchImpl);
  ensureHkufbsPage(reservationPage.url, reservationPage.response.status);
  const pageState = parseHkufbsReservationPage(await reservationPage.response.text());
  const startIso = hongKongIso(input.date, input.start);
  const endIso = hongKongIso(input.date, input.end);
  const resourceRules = parseHkufbsResourceRules(await loadHkufbsReservationData(
    resource.id,
    input,
    pageState.csrf_token,
    jar,
    fetchImpl,
  ), resource.id);
  validateRequestedSlot(input, startIso, resourceRules);
  const baseReservation = reservationObject({
    ownerId: pageState.owner_id,
    resourceId: Number(resource.id),
    start: startIso,
    end: endIso,
    title: input.title?.trim() || null,
    description: input.description?.trim() || null,
    attributes: [],
  });
  const attributes = parseHkufbsAttributes(await postHkufbsJson(
    "attributes",
    baseReservation,
    pageState.csrf_token,
    jar,
    fetchImpl,
  ));
  const warnings = ["A submitted HKUFBS reservation can carry no-show, cancellation, approval, or payment consequences. Confirm the exact room and time before using --yes."];
  if (resourceRules.notes) warnings.push(resourceRules.notes);
  if (resourceRules.requires_approval) warnings.push("This resource requires staff approval.");
  if (/band room/iu.test(resource.name)) {
    warnings.push("Band Room bookings require advance payment through OPS HKU; unpaid reservations are automatically cancelled.");
  }
  const plan: HkufbsReservationPlan = {
    service: "hkufbs",
    resource_id: resource.id,
    resource: resource.name,
    date: input.date,
    start: input.start,
    end: input.end,
    start_iso: startIso,
    end_iso: endIso,
    owner_id: pageState.owner_id,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    requires_approval: resourceRules.requires_approval,
    minimum_notice_minutes: resourceRules.notice_add_minutes,
    min_duration_minutes: resourceRules.min_duration_minutes,
    max_duration_minutes: resourceRules.max_duration_minutes,
    required_attributes: attributes.filter(attribute => attribute.required).map(attribute => ({
      id: attribute.id,
      label: attribute.label,
      ...(attribute.type === undefined ? {} : { type: attribute.type }),
      ...(attribute.possible_values?.length ? { possible_values: attribute.possible_values } : {}),
    })),
    warnings,
    reservation_url: exact[0]!.reservation_url,
  };
  if (input.dryRun !== false) {
    return { plan, submitted: false, success: false, errors: [] };
  }

  const values = attributeValues(attributes, input);
  const reservation = reservationObject({
    ownerId: pageState.owner_id,
    resourceId: Number(resource.id),
    start: startIso,
    end: endIso,
    title: input.title?.trim() || null,
    description: input.description?.trim() || null,
    attributes: values,
  });
  const form = new FormData();
  form.append("request", JSON.stringify({
    reservation,
    retryParameters: [],
    updateScope: "full",
    payment: null,
  }));
  form.append("CSRF_TOKEN", pageState.csrf_token);
  form.append("BROWSER_TIMEZONE", "Asia/Hong_Kong");
  const response = await fetchWithCookies(`${HKUFBS_API_URL}?action=create`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "x-csrf-token": pageState.csrf_token,
      referer: exact[0]!.reservation_url,
    },
    body: form,
  }, jar, fetchImpl);
  ensureHkufbsPage(response.url, response.response.status);
  let payload: unknown;
  try {
    payload = await response.response.json();
  } catch {
    throw new CliError("upstream", "HKUFBS returned a non-JSON response while saving the reservation.");
  }
  const receipt = parseHkufbsSaveReceipt(payload);
  return { plan, submitted: true, ...receipt };
}

function reservationObject(input: {
  ownerId: number;
  resourceId: number;
  start: string;
  end: string;
  title: string | null;
  description: string | null;
  attributes: Array<{ id: number; value: string }>;
}): Record<string, unknown> {
  return {
    referenceNumber: null,
    ownerId: input.ownerId,
    resourceIds: [input.resourceId],
    accessories: [],
    title: input.title,
    description: input.description,
    start: input.start,
    end: input.end,
    recurrence: {
      type: "none",
      interval: 1,
      weekdays: null,
      monthlyType: null,
      weekOfMonth: null,
      terminationDate: null,
      repeatDates: [],
    },
    startReminder: null,
    endReminder: null,
    inviteeIds: [],
    coOwnerIds: [],
    participantIds: [],
    guestEmails: [],
    participantEmails: [],
    allowSelfJoin: false,
    attachments: [],
    requiresApproval: false,
    checkinDate: null,
    checkoutDate: null,
    termsAcceptedDate: null,
    attributeValues: input.attributes,
    meetingLink: null,
    displayColor: null,
    browserTimezone: "Asia/Hong_Kong",
  };
}

function attributeValues(
  attributes: HkufbsAttribute[],
  input: HkufbsBookingInput,
): Array<{ id: number; value: string }> {
  return attributes.map(attribute => {
    const explicit = input.attributes?.[String(attribute.id)] ?? input.attributes?.[attribute.label];
    const label = attribute.label.toLowerCase();
    const inferred = /uid no/iu.test(label)
      ? input.uid
      : /contact no|phone/iu.test(label) ? input.contact : undefined;
    const policyAgreement = attribute.type === 4 && input.acceptPolicy === true
      && /agree|rules|terms|proceeding/iu.test(label) ? "1" : undefined;
    const value = (explicit ?? inferred ?? policyAgreement ?? "").trim();
    if (attribute.required && !value) {
      throw new UsageError(`HKUFBS requires '${attribute.label}'.`, `Pass --attribute '${attribute.id}=VALUE'.`);
    }
    if (/uid no/iu.test(label) && value && !/^\d{10}$/u.test(value)) {
      throw new UsageError("HKUFBS Staff/Student UID No. must contain exactly 10 digits.");
    }
    if (attribute.regex && value) {
      try {
        if (!new RegExp(attribute.regex, "u").test(value)) {
          throw new UsageError(`HKUFBS value for '${attribute.label}' does not match the required format.`);
        }
      } catch (error) {
        if (error instanceof UsageError) throw error;
      }
    }
    return { id: attribute.id, value };
  });
}

async function postHkufbsJson(
  action: string,
  value: Record<string, unknown>,
  csrfToken: string,
  jar: CookieJar,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchWithCookies(`${HKUFBS_API_URL}?api=${encodeURIComponent(action)}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-csrf-token": csrfToken,
      referer: HKUFBS_SEARCH_URL,
    },
    body: JSON.stringify(value),
  }, jar, fetchImpl);
  ensureHkufbsPage(response.url, response.response.status);
  try {
    return await response.response.json();
  } catch {
    throw new CliError("upstream", `HKUFBS returned a non-JSON response for ${action}.`);
  }
}

async function loadHkufbsReservationData(
  resourceId: string,
  input: HkufbsBookingInput,
  csrfToken: string,
  jar: CookieJar,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const url = new URL(HKUFBS_API_URL);
  url.searchParams.set("api", "load");
  url.searchParams.set("sd", `${input.date} ${input.start}:00`);
  url.searchParams.set("ed", `${input.date} ${input.end}:00`);
  url.searchParams.set("sid", "");
  url.searchParams.set("rid", resourceId);
  url.searchParams.set("rd", "");
  url.searchParams.set("rn", "");
  url.searchParams.set("pid", "");
  url.searchParams.set("srn", "");
  const response = await fetchWithCookies(url.toString(), {
    headers: {
      accept: "application/json",
      "x-csrf-token": csrfToken,
      referer: HKUFBS_SEARCH_URL,
    },
  }, jar, fetchImpl);
  ensureHkufbsPage(response.url, response.response.status);
  try {
    return await response.response.json();
  } catch {
    throw new CliError("upstream", "HKUFBS returned a non-JSON response while loading reservation rules.");
  }
}

function validateRequestedSlot(
  input: HkufbsBookingInput,
  startIso: string,
  rules: ReturnType<typeof parseHkufbsResourceRules>,
): void {
  const requestedStart = new Date(startIso).getTime();
  const earliestStart = Date.now() + rules.notice_add_minutes * 60_000;
  if (requestedStart < earliestStart) {
    throw new UsageError(
      `${rules.name} requires ${rules.notice_add_minutes / (24 * 60)} days' advance notice.`,
      `The earliest eligible start is ${new Date(earliestStart).toLocaleString("en-HK", { timeZone: "Asia/Hong_Kong" })}.`,
    );
  }
  const duration = (new Date(hongKongIso(input.date, input.end)).getTime()
    - new Date(hongKongIso(input.date, input.start)).getTime()) / 60_000;
  if ((rules.min_duration_minutes > 0 && duration < rules.min_duration_minutes)
    || (rules.max_duration_minutes > 0 && duration > rules.max_duration_minutes)) {
    throw new UsageError(
      `${rules.name} bookings must last between ${rules.min_duration_minutes} and ${rules.max_duration_minutes} minutes.`,
    );
  }
}

export async function validateHkufbsCookies(
  cookies: readonly WebCookie[],
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  trustSystemCertificates();
  if (!cookies.length) return false;
  try {
    const page = await fetchWithCookies(HKUFBS_SEARCH_URL, { headers: { accept: "text/html" } }, new CookieJar(cookies), fetchImpl);
    if (new URL(page.url).origin !== new URL(HKUFBS_SEARCH_URL).origin) return false;
    const html = await page.response.text();
    return page.response.ok && /HKUFBS/iu.test(html) && /Find A Time/iu.test(html)
      && /name=["']CSRF_TOKEN["']/iu.test(html);
  } catch {
    return false;
  }
}

async function browserHkufbsCookies(options: HkufbsServiceOptions): Promise<WebCookie[]> {
  const authOptions: AuthOptions = {
    homeDir: options.homeDir,
    env: options.env,
    platform: options.platform,
    fetch: options.fetchImpl,
  };
  try {
    const values = await defaultBrowserCookieProvider(HKUFBS_SEARCH_URL, authOptions);
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
  options: HkufbsServiceOptions,
  mode: { headless?: boolean; timeoutMs?: number } = {},
): Promise<WebCookie[]> {
  let validated: WebCookie[] | null = null;
  let lastSignature = "";
  try {
    const result = await loginWithCdp({
      url: HKUFBS_BASE_URL,
      headless: Boolean(mode.headless),
      ...(mode.timeoutMs ? { timeoutMs: mode.timeoutMs } : {}),
      homeDir: options.homeDir,
      env: options.env,
      platform: options.platform,
      profileDir: cdpProfileDir(options.homeDir),
      onOpened: mode.headless ? undefined : () => options.onBrowserOpened?.(HKUFBS_BASE_URL),
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
        if (await validateHkufbsCookies(stateCookies, options.fetchImpl ?? globalThis.fetch)) {
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

async function saveHkufbsSession(cookies: WebCookie[], options: HkufbsServiceOptions): Promise<void> {
  await writeSecureState<HkufbsSessionState>(
    HKUFBS_STATE_NAME,
    { version: 1, cookies, saved_at: Date.now() },
    secureOptions(options),
  );
}

function ensureHkufbsPage(url: string, status: number): void {
  if (status >= 400) throw new CliError("upstream", `HKUFBS returned HTTP ${status}.`);
  const parsed = new URL(url);
  if (parsed.origin !== new URL(HKUFBS_SEARCH_URL).origin || /\/index\.php/iu.test(parsed.pathname)) {
    throw new AuthError("The HKUFBS session needs sign-in.", "Run `hku facilities hkufbs login` and complete HKU SSO.");
  }
}

function secureOptions(options: HkufbsServiceOptions): SecureStateOptions {
  return { ...(options.homeDir ? { homeDir: options.homeDir } : {}) };
}
