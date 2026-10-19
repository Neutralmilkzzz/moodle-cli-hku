export interface WebCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

export interface CookieFetchResult {
  response: Response;
  url: string;
}

interface StoredCookie extends WebCookie {
  domain: string;
  path: string;
  expires?: number;
}

const MAX_REDIRECTS = 15;

/**
 * A deliberately small cookie jar for HKU's SSO and return redirects. It only
 * sends cookies to matching domains and paths; login redirects can cross HKU
 * hosts without leaking the cookie set to an unrelated origin.
 */
export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  constructor(initial: readonly WebCookie[] = []) {
    for (const cookie of initial) this.set(cookie, cookie.domain ? `https://${cookie.domain.replace(/^\./u, "")}/` : undefined);
  }

  set(cookie: WebCookie, responseUrl?: string): void {
    if (!cookie.name || cookie.value === undefined) return;
    const fallbackHost = responseUrl ? new URL(responseUrl).hostname : "";
    const domain = (cookie.domain || fallbackHost).replace(/^\./u, "").toLowerCase();
    if (!domain) return;
    const path = cookie.path?.startsWith("/") ? cookie.path : "/";
    if (cookie.expires !== undefined && cookie.expires <= Date.now()) {
      this.cookies.delete(this.key(domain, path, cookie.name));
      return;
    }
    this.cookies.set(this.key(domain, path, cookie.name), {
      ...cookie,
      domain,
      path,
      ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    });
  }

  absorb(headers: Headers, url: string): void {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : splitSetCookieHeader(headers.get("set-cookie") ?? "");
    for (const value of values) {
      const parsed = parseSetCookie(value, url);
      if (parsed) this.set(parsed, url);
    }
  }

  header(url: string): string {
    const target = new URL(url);
    if (target.protocol !== "https:" && target.protocol !== "http:") return "";
    const host = target.hostname.toLowerCase();
    const path = target.pathname || "/";
    return [...this.cookies.values()]
      .filter(cookie => {
        if (!cookie.value) return false;
        if (cookie.expires !== undefined && cookie.expires <= Date.now()) return false;
        if (cookie.secure && target.protocol !== "https:") return false;
        return hostMatches(host, cookie.domain) && pathMatches(path, cookie.path);
      })
      .sort((left, right) => right.path.length - left.path.length || left.name.localeCompare(right.name))
      .map(cookie => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  serialize(): WebCookie[] {
    return [...this.cookies.values()].map(({ name, value, domain, path, secure, httpOnly, expires }) => ({
      name,
      value,
      domain,
      path,
      ...(secure === undefined ? {} : { secure }),
      ...(httpOnly === undefined ? {} : { httpOnly }),
      ...(expires === undefined ? {} : { expires }),
    }));
  }

  private key(domain: string, path: string, name: string): string {
    return `${domain}\0${path}\0${name}`;
  }
}

export function parseCookieHeader(value: string): WebCookie[] {
  return value
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .flatMap(part => {
      const index = part.indexOf("=");
      if (index <= 0) return [];
      return [{ name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() }];
    });
}

export async function fetchWithCookies(
  input: string,
  init: RequestInit,
  jar: CookieJar,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CookieFetchResult> {
  let url = new URL(input);
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  const headers = new Headers(init.headers);

  for (let hop = 0; ; hop += 1) {
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error("The request destination is not allowed.");
    }
    const requestHeaders = new Headers(headers);
    const cookie = jar.header(url.toString());
    if (cookie) requestHeaders.set("cookie", cookie);
    if (url.origin !== new URL(input).origin) {
      requestHeaders.delete("authorization");
      requestHeaders.delete("proxy-authorization");
    }
    const response = await fetchImpl(url, { ...init, method, body, headers: requestHeaders, redirect: "manual" });
    jar.absorb(response.headers, url.toString());
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return { response, url: url.toString() };
    }
    const location = response.headers.get("location");
    if (!location) return { response, url: url.toString() };
    await response.body?.cancel();
    if (hop >= MAX_REDIRECTS) throw new Error("The request exceeded its redirect limit.");
    const next = new URL(location, url);
    if (url.protocol === "https:" && next.protocol !== "https:") {
      throw new Error("The request refused an insecure redirect.");
    }
    if ((response.status === 303 && method !== "HEAD") || ([301, 302].includes(response.status) && method === "POST")) {
      method = "GET";
      body = undefined;
      for (const name of ["content-type", "content-length", "content-encoding", "content-language", "content-location"]) {
        headers.delete(name);
      }
    }
    url = next;
  }
}

export function parseSetCookie(value: string, responseUrl: string): WebCookie | null {
  const pieces = value.split(";").map(piece => piece.trim()).filter(Boolean);
  const first = pieces.shift();
  if (!first) return null;
  const separator = first.indexOf("=");
  if (separator <= 0) return null;
  const cookie: WebCookie = {
    name: first.slice(0, separator).trim(),
    value: first.slice(separator + 1),
  };
  for (const attribute of pieces) {
    const index = attribute.indexOf("=");
    const key = (index >= 0 ? attribute.slice(0, index) : attribute).trim().toLowerCase();
    const raw = index >= 0 ? attribute.slice(index + 1).trim() : "";
    if (key === "domain" && raw) cookie.domain = raw.replace(/^\./u, "").toLowerCase();
    else if (key === "path" && raw) cookie.path = raw;
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "expires" || key === "max-age") {
      const expires = key === "max-age"
        ? Date.now() + Number(raw) * 1000
        : Date.parse(raw);
      if (Number.isFinite(expires)) cookie.expires = expires;
    }
  }
  if (!cookie.domain) cookie.domain = new URL(responseUrl).hostname;
  return cookie;
}

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(path: string, cookiePath: string): boolean {
  if (cookiePath === "/") return true;
  return path === cookiePath || path.startsWith(`${cookiePath.replace(/\/$/u, "")}/`);
}

function splitSetCookieHeader(value: string): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+\s*=)/u);
}
