/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Source capability matrix.
 *
 * A source may only be wired into the pipeline when it can deliver new records
 * with no owner action AND that ability is backed by observed evidence. This
 * module is the single place that records which sources qualify, so an
 * unsupported source can never be silently "upgraded" into a supported one.
 *
 * Evidence for the OpenHands claim is a live read of the Cloud API V1 against a
 * real conversation (see docs/conversation-sync/SOURCE_CAPABILITY_MATRIX.md).
 * Evidence for the ChatGPT claim is the official OpenAI export documentation:
 * history is a user-requested export, not a background feed.
 */

import type { SourceCapability, SourceKind } from './types.ts';

export const SOURCE_CAPABILITIES: Record<SourceKind, SourceCapability> = {
  openhands: {
    source: 'openhands',
    displayName: 'OpenHands Cloud sessions',
    unattended: true,
    stableIds: true,
    supportsEdits: true,
    supportsDeletions: true,
    officialRefs: [
      'https://docs.openhands.dev/enterprise/conversations-and-sandboxes',
      'https://docs.openhands.dev/openhands/usage/cloud/api-reference/events/search-events',
    ],
    evidence:
      'GET /api/v1/app-conversations/search and GET /api/v1/conversation/{id}/events/search both returned HTTP 200 ' +
      'with a bearer token, exposing stable conversation ids, selected_repository routing metadata, per-event UUIDs ' +
      'and ISO timestamps. The events endpoint paginates with next_page_id and supports sort_order TIMESTAMP/TIMESTAMP_DESC.',
    accessRequirements:
      'OPENHANDS_API_KEY (Cloud bearer token). Read-only: the pipeline calls only GET endpoints.',
  },
  'chatgpt-personal': {
    source: 'chatgpt-personal',
    displayName: 'ChatGPT personal conversations',
    unattended: false,
    stableIds: false,
    supportsEdits: false,
    supportsDeletions: false,
    officialRefs: [
      'https://help.openai.com/en/articles/7260999-how-to-export-your-chatgpt-history-and-data',
      'https://help.openai.com/en/articles/8167885-how-to-export-your-data-from-the-chatgpt-android-app',
    ],
    evidence:
      'The official export article describes only user-initiated export: "Under Export data, select Export." ' +
      'No continuous per-message webhook or unattended conversation-history API is documented.',
    accessRequirements:
      'Owner-initiated data export through Settings or the Privacy Portal; an archive is delivered later.',
    blocker:
      'UNSUPPORTED for unattended sync: OpenAI documents history export as a user-requested process with no ' +
      'documented background API or webhook for personal conversations. No zero-action source exists, so this ' +
      'source is excluded from the pipeline rather than approximated by manual export.',
  },
};

/** Sources that qualify for the unattended pipeline. */
export function supportedSources(): SourceCapability[] {
  return Object.values(SOURCE_CAPABILITIES).filter((s) => s.unattended);
}

/** Sources that are explicitly out of scope, with the reason. */
export function unsupportedSources(): SourceCapability[] {
  return Object.values(SOURCE_CAPABILITIES).filter((s) => !s.unattended);
}

/** Human-readable one-line names of the unsupported sources, for the status file. */
export function unsupportedSourceNames(): string[] {
  return unsupportedSources().map((s) => `${s.displayName}: ${s.blocker ?? 'unsupported'}`);
}
