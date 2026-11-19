// kit.ts — the small shared plumbing every surface of the forge stands on:
// the request context handed to a handler, the reply a handler returns, and
// the helpers that turn those into bytes on the wire. Nothing here knows
// about git, issues or pull requests; it only knows HTTP and JSON.

export interface Ctx {
  method: string;
  /** Decoded path segments, without a leading or trailing empty segment. */
  parts: string[];
  /** The request's pathname exactly as it arrived, e.g. `/api/v3/user/repos`. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  /** The raw request body; empty for a bodyless request. */
  body: Buffer;
  /** The Host header the request arrived with, for same-origin links. */
  host: string;
  /** True when the Authorization header carries the trial token. */
  authed: boolean;
}

export interface Reply {
  status: number;
  /** Extra headers beyond the JSON content type and the request id. */
  headers?: Record<string, string>;
  /** A value serialised as JSON. Ignored when `raw` is set. */
  body?: unknown;
  /** A pre-serialised JSON string, sent as-is with the JSON content type. */
  rawJson?: string;
  /** Exact bytes to send, with `contentType` naming their media type. */
  raw?: Buffer;
  contentType?: string;
}

export function jsonReply(status: number, body: unknown, headers?: Record<string, string>): Reply {
  return { status, body, headers };
}

export function errReply(status: number, message: string): Reply {
  return { status, body: { message } };
}

/** Parse the request body as JSON. Returns null when it is not an object. */
export function bodyJson(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** True when the body parses as JSON at all (object, array or scalar). */
export function bodyParses(ctx: Ctx): boolean {
  if (ctx.body.length === 0) return true;
  try {
    JSON.parse(ctx.body.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

export function strField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

export function boolField(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

export function intQuery(query: URLSearchParams, key: string, fallback: number): number {
  const raw = query.get(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** A page of `items`, with the page size clamped to something sane. */
export function pageOf<T>(items: readonly T[], query: URLSearchParams): { page: T[]; hasMore: boolean; pageNo: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, intQuery(query, 'per_page', 30)));
  const pageNo = Math.max(1, intQuery(query, 'page', 1));
  const start = (pageNo - 1) * perPage;
  return { page: items.slice(start, start + perPage), hasMore: start + perPage < items.length, pageNo, perPage };
}

let requestCounter = 0;

/** A short request id for the X-GitHub-Request-Id header; a counter, so it never repeats. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

/** One header value from a request, case-insensitively, first value wins. */
export function headerText(ctx: Ctx, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(ctx.headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0];
    return value;
  }
  return undefined;
}
