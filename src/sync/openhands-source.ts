/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Adapter from the OpenHands Cloud API client to the pipeline's SourceReader.
 *
 * The pipeline only sees normalized, source-faithful messages; all API specifics
 * (pagination, event shapes, redaction) stay behind this boundary.
 */

import { OpenHandsClient, type OpenHandsConversation } from './openhands-client.ts';
import { normalizeEvents } from './transcript.ts';
import type { SourceConversation, SourceReader } from './pipeline.ts';
import type { TranscriptMessage } from './types.ts';

export function toSourceConversation(c: OpenHandsConversation): SourceConversation {
  const uiUrl = typeof c.raw?.conversation_ui_url === 'string' ? (c.raw.conversation_ui_url as string) : null;
  return {
    id: c.id,
    title: c.title,
    selectedRepository: c.selectedRepository,
    conversationUiUrl: uiUrl,
  };
}

export class OpenHandsSourceReader implements SourceReader {
  private readonly client: OpenHandsClient;

  constructor(client: OpenHandsClient) {
    this.client = client;
  }

  async listConversations(limit: number): Promise<SourceConversation[]> {
    const conversations = await this.client.listConversations(limit);
    return conversations.map(toSourceConversation);
  }

  async listMessages(conversationId: string): Promise<TranscriptMessage[]> {
    const events = await this.client.listEvents(conversationId);
    return normalizeEvents(events);
  }
}
