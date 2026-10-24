/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Adapter from the OpenHands Cloud API client to the pipeline's SourceReader.
 *
 * The pipeline only sees normalized, source-faithful messages; all API specifics
 * (pagination, event shapes, redaction) stay behind this boundary.
 *
 * Completeness is first-class here. `readConversation` reports how many pages
 * were read, whether pagination finished, how many message events the source
 * *declares* it has, and how many it actually returned. The pipeline turns a
 * mismatch or an unfinished read into a visible gap instead of trusting a
 * truncated stream.
 */

import {
  OpenHandsClient,
  type ConversationInventory,
  type OpenHandsConversation,
} from './openhands-client.ts';
import { normalizeEvents } from './transcript.ts';
import type { SourceConversation, SourceConversationInventory, SourceReadResult } from './pipeline.ts';
import type { TranscriptMessage } from './types.ts';

/** The event kind that carries conversation text; the count check filters on it. */
export const MESSAGE_EVENT_KIND = 'MessageEvent';

export function toSourceConversation(c: OpenHandsConversation): SourceConversation {
  const uiUrl = typeof c.raw?.conversation_ui_url === 'string' ? (c.raw.conversation_ui_url as string) : null;
  return {
    id: c.id,
    title: c.title,
    selectedRepository: c.selectedRepository,
    conversationUiUrl: uiUrl,
  };
}

export class OpenHandsSourceReader {
  private readonly client: OpenHandsClient;

  constructor(client: OpenHandsClient) {
    this.client = client;
  }

  async listConversationsDetailed(limit: number): Promise<SourceConversationInventory> {
    const inv: ConversationInventory = await this.client.listConversationsDetailed(limit);
    return {
      conversations: inv.conversations.map(toSourceConversation),
      totalAvailable: inv.totalAvailable,
      truncated: inv.truncated,
      inventoryComplete: inv.inventoryComplete,
    };
  }

  async listConversations(limit: number): Promise<SourceConversation[]> {
    return (await this.listConversationsDetailed(limit)).conversations;
  }

  /**
   * Read one conversation with completeness metadata.
   *
   * The declared count is filtered to `MessageEvent` because the unfiltered
   * count endpoint over-reports versus the paginated stream (observed live:
   * +1 to +2 on nearly every conversation), which would raise a spurious gap on
   * every run. The filtered count matched the stream exactly on all 27 live
   * conversations.
   */
  async readConversation(conversationId: string): Promise<SourceReadResult> {
    const read = await this.client.listEventsDetailed(conversationId);
    const messages = normalizeEvents(read.events);
    let declaredMessages: number | null = null;
    try {
      declaredMessages = await this.client.countEvents(conversationId, { kind: MESSAGE_EVENT_KIND });
    } catch {
      // A missing count endpoint must not fail the read; the pipeline treats a
      // null declared count as "unverified", never as "complete".
      declaredMessages = null;
    }
    return {
      messages,
      eventsRead: read.events.length,
      observedMessages: messages.length,
      declaredMessages,
      paginationComplete: read.paginationComplete,
      pages: read.pages,
    };
  }

  async listMessages(conversationId: string): Promise<TranscriptMessage[]> {
    return (await this.readConversation(conversationId)).messages;
  }
}
