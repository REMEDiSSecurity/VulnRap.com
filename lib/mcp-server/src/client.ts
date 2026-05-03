export const DEFAULT_BASE_URL = "https://vulnrap.com";

export function getBaseUrl(): string {
  const env = process.env["VULNRAP_API_BASE_URL"];
  if (env && env.trim().length > 0) return env.replace(/\/+$/, "");
  return DEFAULT_BASE_URL;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  form?: Record<string, string | undefined | null>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export class HttpError extends Error {
  status: number;
  bodyText: string;
  constructor(status: number, message: string, bodyText: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export async function apiRequest<T = unknown>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const base = getBaseUrl();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, base);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;

  if (opts.form) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(opts.form)) {
      if (v === undefined || v === null) continue;
      fd.append(k, v);
    }
    body = fd;
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  const ctrl = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(
        res.status,
        `VulnRap API ${res.status} ${res.statusText} for ${opts.method ?? "GET"} ${url.pathname}`,
        text,
      );
    }
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } finally {
    clearTimeout(timer);
  }
}
