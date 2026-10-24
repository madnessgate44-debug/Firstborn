/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal, read-only OpenHands Cloud API V1 client.
 *
 * Only GET endpoints are called. The client never starts, mutates, or deletes a
 * conversation, so a sync run cannot change the source it reads.
 *
 * Pagination uses the response envelope's `next_page_id` cursor rather than an
 * offset: the events endpoint returns `next_page_id: null` on the last page and
 * an opaque cursor otherwise, so a page is never skipped by guessing offsets.
 *
 * Two source facts observed live (2026-10-24) shape this client:
 *
 *  1. The unfiltered `events/count` endpoint over-reports: it returns 1-2 more
 *     than the paginated `events/search` stream for nearly every conversation
 *     (e.g. 557 vs 555). `countEvents(id, { kind })` therefore filters by kind;
 *     `count?kind__eq=MessageEvent` matched the stream exactly for all 27 live
 *     conversations, so the count check uses that filter.
 *  2. A truncated read must never look like a complete one. Both pagination
 *     loops fail loudly when a cursor remains but the loop cannot continue, so a
 *     partial event stream or a partial conversation inventory is an error the
 *     caller must handle, not a silent short result.
 */

import type { RawEvent } from './types.ts';

const DEFAULT_BASE_URL = 'https://app.all-hands.dev';
const EVENTS_PAGE_LIMIT = 100;

/** Hard bound on event pagination. Exceeding it is an error, never a short read. */
export const EVENTS_PAGE_GUARD = 10_000;

/** Hard bound on the conversation-inventory scan, to keep a run bounded. */
export const CONVERSATIONS_HARD_CAP = 2_000;

export interface OpenHandsConversation {
  id: string;
  title: string | null;
  selectedRepository: string | null;
  selectedBranch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  executionStatus: string | null;
  raw: Record<string, unknown>;
}

/** Result of a paginated event read, with completeness metadata. */
export interface EventReadResult {
  events: RawEvent[];
  /** Number of pages fetched. */
  pages: number;
  /** True only when the read reached the source's last page. */
  paginationComplete: boolean;
}

/** Result of a conversation-inventory read, with truncation metadata. */
export interface ConversationInventory {
  /** The conversations returned (at most `limit`). */
  conversations: OpenHandsConversation[];
  /** Total conversations the source reports; a lower bound when `inventoryComplete` is false. */
  totalAvailable: number;
  /** How many conversations were returned. */
  returned: number;
  /** True when the source holds more conversations than were returned. */
  truncated: boolean;
  /** False when the hard cap stopped the scan before the source's cursor ended. */
  inventoryComplete: boolean;
}

export interface FetchLike {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
    /** Optional response headers; used to honour `Retry-After` on a 429. */
    headers?: { get(name: string): string | null };
  }>;
}

export interface OpenHandsClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Override the retry policy (tests use a no-op sleep). */
  retry?: Partial<RetryPolicy>;
  /** Override request pacing (tests use a no-op sleep). */
  throttle?: Partial<ThrottlePolicy>;
}

/** Client-side pacing, so a burst read stays under the API's own rate limits. */
export interface ThrottlePolicy {
  /** Minimum gap between consecutive requests, in milliseconds. */
  minIntervalMs: number;
  /** Rolling-window cap on requests per minute. */
  maxRequestsPerMinute: number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
}

/** Retry policy for a single request. Retries only on transient statuses. */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  /** Attempts used for a rate-limited (429) response, which needs a longer window. */
  rateLimitAttempts: number;
  /** Base backoff for a 429 with no `Retry-After` header. */
  rateLimitBaseDelayMs: number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Parse a `Retry-After` header, in seconds or HTTP-date form. Returns null when
 * absent or unparseable.
 */
function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenHandsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  readonly retry: RetryPolicy;
  private readonly throttle: ThrottlePolicy;
  /** Timestamps (ms) of recent requests, for the rolling-minute cap. */
  private requestTimes: number[] = [];
  private lastRequestAt = 0;
  /** Serialises pacing so concurrent reads share one budget. */
  private pacing: Promise<void> = Promise.resolve();

  constructor(opts: OpenHandsClientOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) throw new Error('OpenHandsClient: apiKey is required');
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as any).fetch as FetchLike);
    if (!this.fetchImpl) throw new Error('OpenHandsClient: no fetch implementation available');
    // The Cloud API enforces 100 requests/minute (observed live: HTTP 429 with
    // {"error":"Rate limit exceeded: 100 per 1 minute"}) and a burst limit
    // ({"error":"Rate limit exceeded: 10 per 1 second"}). A 429 therefore gets a
    // dedicated retry budget, and requests are paced below both limits so a
    // long paginated read does not have to rely on retries to finish.
    this.retry = {
      maxAttempts: 4,
      baseDelayMs: 250,
      rateLimitAttempts: 6,
      rateLimitBaseDelayMs: 15_000,
      ...opts.retry,
    };
    this.throttle = {
      minIntervalMs: 150,
      maxRequestsPerMinute: 90,
      ...opts.throttle,
    };
  }

  private sleep(ms: number): Promise<void> {
    return (this.retry.sleep ?? sleep)(ms);
  }

  private throttleSleep(ms: number): Promise<void> {
    return (this.throttle.sleep ?? sleep)(ms);
  }

  private throttleNow(): number {
    return (this.throttle.now ?? Date.now)();
  }

  /**
   * Wait until the next request is allowed, then record it.
   *
   * Serialised through a promise chain so several concurrent reads share one
   * request budget instead of each assuming it is alone.
   */
  private async pace(): Promise<void> {
    const run = this.pacing.then(async () => {
      const now = this.throttleNow();
      // Enforce the minimum gap between requests.
      const sinceLast = now - this.lastRequestAt;
      if (sinceLast < this.throttle.minIntervalMs) {
        await this.throttleSleep(this.throttle.minIntervalMs - sinceLast);
      }
      // Enforce the rolling-minute cap.
      const now2 = this.throttleNow();
      this.requestTimes = this.requestTimes.filter((t) => now2 - t < 60_000);
      if (this.requestTimes.length >= this.throttle.maxRequestsPerMinute) {
        const oldest = this.requestTimes[0];
        await this.throttleSleep(60_000 - (now2 - oldest) + 1);
        const now3 = this.throttleNow();
        this.requestTimes = this.requestTimes.filter((t) => now3 - t < 60_000);
      }
      this.lastRequestAt = this.throttleNow();
      this.requestTimes.push(this.lastRequestAt);
    });
    // Keep the chain alive even if a caller's pacing wait rejects.
    this.pacing = run.catch(() => {});
    return run;
  }

  private async getJson(path: string): Promise<any> {
    const url = `${this.baseUrl}/api/v1${path}`;
    let lastError = '';
    let rateLimitHits = 0;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      let res;
      try {
        await this.pace();
        res = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        });
      } catch (err: any) {
        lastError = `network error: ${err?.message ?? String(err)}`;
        if (attempt < this.retry.maxAttempts) {
          await this.sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`OpenHands GET ${path} failed: ${lastError}`);
      }

      if (res.ok) {
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(`OpenHands GET ${path} returned non-JSON body`);
        }
      }

      const body = await res.text().catch(() => '');
      lastError = `HTTP ${res.status}: ${body.slice(0, 300)}`;

      if (res.status === 429) {
        // Honour Retry-After when present; otherwise back off exponentially. A
        // 429 does not consume the transient-retry budget: it has its own.
        rateLimitHits += 1;
        if (rateLimitHits <= this.retry.rateLimitAttempts) {
          const header = res.headers?.get?.('retry-after') ?? null;
          const wait = parseRetryAfter(header, Date.now()) ?? this.retry.rateLimitBaseDelayMs * rateLimitHits;
          await this.sleep(wait);
          attempt -= 1; // a rate-limit retry does not count against maxAttempts
          continue;
        }
        throw new Error(`OpenHands GET ${path} failed: ${lastError} (rate-limited ${rateLimitHits}x)`);
      }

      if (RETRYABLE_STATUS.has(res.status) && attempt < this.retry.maxAttempts) {
        await this.sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`OpenHands GET ${path} failed: ${lastError}`);
    }
    throw new Error(`OpenHands GET ${path} failed after retries: ${lastError}`);
  }

  /**
   * List conversations, with explicit truncation metadata.
   *
   * The scan follows the cursor to the end (bounded by `hardCap`) so it can
   * report how many conversations actually exist, then returns the first
   * `limit`. A caller can therefore tell "I examined everything" from "I
   * examined a subset of a larger inventory" instead of silently dropping the
   * conversations past the limit.
   */
  async listConversationsDetailed(
    limit = 50,
    opts: { hardCap?: number } = {}
  ): Promise<ConversationInventory> {
    const hardCap = opts.hardCap ?? CONVERSATIONS_HARD_CAP;
    const all: OpenHandsConversation[] = [];
    let pageId: string | null = null;
    let inventoryComplete = false;
    while (all.length < hardCap) {
      const pageSize = Math.min(hardCap - all.length, 50);
      const params = new URLSearchParams({ limit: String(pageSize) });
      if (pageId) params.set('page_id', pageId);
      const page = await this.getJson(`/app-conversations/search?${params.toString()}`);
      const items: any[] = Array.isArray(page?.items) ? page.items : [];
      for (const item of items) all.push(toConversation(item));
      pageId = typeof page?.next_page_id === 'string' ? page.next_page_id : null;
      if (!pageId || items.length === 0) {
        inventoryComplete = true;
        break;
      }
    }
    const conversations = all.slice(0, limit);
    return {
      conversations,
      totalAvailable: all.length,
      returned: conversations.length,
      truncated: all.length > conversations.length,
      inventoryComplete,
    };
  }

  /** List up to `limit` conversations (compatibility wrapper). */
  async listConversations(limit = 50): Promise<OpenHandsConversation[]> {
    return (await this.listConversationsDetailed(limit)).conversations;
  }

  async getConversation(conversationId: string): Promise<OpenHandsConversation | null> {
    const res = await this.getJson(`/app-conversations?ids=${encodeURIComponent(conversationId)}`);
    const items: any[] = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
    return items.length ? toConversation(items[0]) : null;
  }

  /**
   * Total event count for a conversation, used for gap detection.
   *
   * Pass `{ kind }` to filter: the unfiltered count over-reports versus the
   * paginated stream, while `kind: 'MessageEvent'` matches it exactly.
   */
  async countEvents(conversationId: string, opts: { kind?: string } = {}): Promise<number> {
    const qs = opts.kind ? `?kind__eq=${encodeURIComponent(opts.kind)}` : '';
    const res = await this.getJson(`/conversation/${encodeURIComponent(conversationId)}/events/count${qs}`);
    return Number(typeof res === 'number' ? res : (res?.count ?? 0)) || 0;
  }

  /**
   * Fetch every event for a conversation in ascending timestamp order, with
   * completeness metadata.
   *
   * `sort_order=TIMESTAMP` is the API's ascending order; `TIMESTAMP_DESC` is the
   * descending order. The pipeline archives ascending so message order is
   * preserved exactly as the source produced it.
   */
  async listEventsDetailed(
    conversationId: string,
    opts: { kind?: string; pageGuard?: number } = {}
  ): Promise<EventReadResult> {
    const guardLimit = opts.pageGuard ?? EVENTS_PAGE_GUARD;
    const out: RawEvent[] = [];
    let pageId: string | null = null;
    for (let guard = 0; guard < guardLimit; guard += 1) {
      const params = new URLSearchParams({ limit: String(EVENTS_PAGE_LIMIT), sort_order: 'TIMESTAMP' });
      if (opts.kind) params.set('kind__eq', opts.kind);
      if (pageId) params.set('page_id', pageId);
      const page = await this.getJson(
        `/conversation/${encodeURIComponent(conversationId)}/events/search?${params.toString()}`
      );
      const items: any[] = Array.isArray(page?.items) ? page.items : [];
      for (const item of items) {
        if (item && typeof item.id === 'string') out.push(item as RawEvent);
      }
      pageId = typeof page?.next_page_id === 'string' ? page.next_page_id : null;
      if (!pageId) return { events: out, pages: guard + 1, paginationComplete: true };
      if (items.length === 0) {
        throw new Error(
          `OpenHands event stream for ${conversationId} returned an empty page but still reports a next page; ` +
            'refusing to return a partial event stream'
        );
      }
    }
    throw new Error(
      `OpenHands event pagination for ${conversationId} exceeded the ${guardLimit}-page guard while the ` +
        'source still reports a next page; refusing to return a partial event stream'
    );
  }

  /** Fetch every event for a conversation in ascending order (compatibility wrapper). */
  async listEvents(conversationId: string): Promise<RawEvent[]> {
    return (await this.listEventsDetailed(conversationId)).events;
  }
}

function toConversation(item: any): OpenHandsConversation {
  return {
    id: String(item?.id ?? ''),
    title: typeof item?.title === 'string' ? item.title : null,
    selectedRepository: typeof item?.selected_repository === 'string' ? item.selected_repository : null,
    selectedBranch: typeof item?.selected_branch === 'string' ? item.selected_branch : null,
    createdAt: typeof item?.created_at === 'string' ? item.created_at : null,
    updatedAt: typeof item?.updated_at === 'string' ? item.updated_at : null,
    executionStatus: typeof item?.execution_status === 'string' ? item.execution_status : null,
    raw: item as Record<string, unknown>,
  };
}
