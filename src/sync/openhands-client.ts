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
 */

import type { RawEvent } from './types.ts';

const DEFAULT_BASE_URL = 'https://app.all-hands.dev';
const EVENTS_PAGE_LIMIT = 100;

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

export interface FetchLike {
  (url: string, init?: { headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
}

export interface OpenHandsClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
}

/** Retry policy for a single request. Retries only on transient statuses. */
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenHandsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  readonly retry: RetryPolicy;

  constructor(opts: OpenHandsClientOptions) {
    if (!opts.apiKey || !opts.apiKey.trim()) throw new Error('OpenHandsClient: apiKey is required');
    this.apiKey = opts.apiKey.trim();
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((globalThis as any).fetch as FetchLike);
    if (!this.fetchImpl) throw new Error('OpenHandsClient: no fetch implementation available');
    this.retry = { maxAttempts: 4, baseDelayMs: 250 };
  }

  private async getJson(path: string): Promise<any> {
    const url = `${this.baseUrl}/api/v1${path}`;
    let lastError = '';
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      let res;
      try {
        res = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
        });
      } catch (err: any) {
        lastError = `network error: ${err?.message ?? String(err)}`;
        if (attempt < this.retry.maxAttempts) {
          await sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
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
      if (RETRYABLE_STATUS.has(res.status) && attempt < this.retry.maxAttempts) {
        await sleep(this.retry.baseDelayMs * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`OpenHands GET ${path} failed: ${lastError}`);
    }
    throw new Error(`OpenHands GET ${path} failed after retries: ${lastError}`);
  }

  /** List conversations, following the cursor until `limit` records are collected. */
  async listConversations(limit = 50): Promise<OpenHandsConversation[]> {
    const out: OpenHandsConversation[] = [];
    let pageId: string | null = null;
    while (out.length < limit) {
      const remaining = limit - out.length;
      const pageSize = Math.min(remaining, 50);
      const params = new URLSearchParams({ limit: String(pageSize) });
      if (pageId) params.set('page_id', pageId);
      const page = await this.getJson(`/app-conversations/search?${params.toString()}`);
      const items: any[] = Array.isArray(page?.items) ? page.items : [];
      for (const item of items) out.push(toConversation(item));
      pageId = typeof page?.next_page_id === 'string' ? page.next_page_id : null;
      if (!pageId || items.length === 0) break;
    }
    return out.slice(0, limit);
  }

  async getConversation(conversationId: string): Promise<OpenHandsConversation | null> {
    const res = await this.getJson(`/app-conversations?ids=${encodeURIComponent(conversationId)}`);
    const items: any[] = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
    return items.length ? toConversation(items[0]) : null;
  }

  /** Total event count for a conversation; used for gap detection. */
  async countEvents(conversationId: string): Promise<number> {
    const res = await this.getJson(`/conversation/${encodeURIComponent(conversationId)}/events/count`);
    return Number(typeof res === 'number' ? res : res?.count ?? 0) || 0;
  }

  /**
   * Fetch every event for a conversation in ascending timestamp order.
   *
   * `sort_order=TIMESTAMP` is the API's ascending order; `TIMESTAMP_DESC` is the
   * descending order. The pipeline archives ascending so message order is
   * preserved exactly as the source produced it.
   */
  async listEvents(conversationId: string): Promise<RawEvent[]> {
    const out: RawEvent[] = [];
    let pageId: string | null = null;
    for (let guard = 0; guard < 10_000; guard += 1) {
      const params = new URLSearchParams({ limit: String(EVENTS_PAGE_LIMIT), sort_order: 'TIMESTAMP' });
      if (pageId) params.set('page_id', pageId);
      const page = await this.getJson(
        `/conversation/${encodeURIComponent(conversationId)}/events/search?${params.toString()}`
      );
      const items: any[] = Array.isArray(page?.items) ? page.items : [];
      for (const item of items) {
        if (item && typeof item.id === 'string') out.push(item as RawEvent);
      }
      pageId = typeof page?.next_page_id === 'string' ? page.next_page_id : null;
      if (!pageId || items.length === 0) break;
    }
    return out;
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
