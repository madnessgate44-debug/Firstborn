/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zero-user-action conversation synchronization — shared types.
 *
 * Everything here is data only. The behaviour lives in the sibling modules so the
 * routing, redaction, batching and checkpoint logic stays pure and unit-testable.
 */

/** A conversation source the pipeline knows how to reason about. */
export type SourceKind = 'openhands' | 'chatgpt-personal';

/** Declared capability of a source, with the evidence that backs the declaration. */
export interface SourceCapability {
  source: SourceKind;
  displayName: string;
  /** True only when new records arrive with no owner action (no manual export). */
  unattended: boolean;
  /** True when the source exposes a stable per-record identifier. */
  stableIds: boolean;
  /** True when the source can report later edits to an existing record. */
  supportsEdits: boolean;
  /** True when the source can report deletions of an existing record. */
  supportsDeletions: boolean;
  /** Official documentation that describes the access path. */
  officialRefs: string[];
  /** Concrete, observed evidence for the capability claim (never a guess). */
  evidence: string;
  /** Credential / permission required to use the path. */
  accessRequirements: string;
  /** Present when the source cannot deliver unattended records. */
  blocker?: string;
}

/** One raw event as returned by a source, before normalization. */
export interface RawEvent {
  id: string;
  timestamp: string;
  source: string;
  kind?: string;
  [key: string]: unknown;
}

/** A normalized, source-faithful transcript message. */
export interface TranscriptMessage {
  /** Stable source message id (never synthesized). */
  id: string;
  speaker: 'user' | 'assistant' | 'system';
  timestamp: string;
  /** Redacted verbatim text. */
  text: string;
}

/** Stable per-source checkpoint. Never a wall-clock time alone. */
export interface Checkpoint {
  source: SourceKind;
  conversationId: string;
  /** Last message id durably written for this conversation. */
  lastMessageId: string | null;
  /** Timestamp of that message, for lag calculation and ordering checks. */
  lastTimestamp: string | null;
  /** Count of messages written so far; a drop signals lost history. */
  syncedCount: number;
  updatedAt: string;
}

/** A detected discontinuity between the source and what we have archived. */
export interface SyncGap {
  conversationId: string;
  reason: string;
  detectedAt: string;
}

/** Result of planning one idempotent batch. Pure. */
export interface BatchPlan {
  /** New messages to append, in source order. */
  batch: TranscriptMessage[];
  /** Ids already present that the source re-sent (proves idempotency). */
  duplicates: string[];
  /** True when there is nothing new to write. */
  noop: boolean;
  gap: SyncGap | null;
}

/** Per-conversation status line surfaced in the dashboard. */
export interface ConversationStatus {
  conversationId: string;
  repository: string;
  title: string;
  /**
   * Cumulative count of messages durably archived for this conversation, from
   * its checkpoint — not just this run's batch. Distinguishing the two is what
   * stops a partial run from looking like the whole archive.
   */
  messageCount: number;
  /** Messages appended by *this* run. */
  addedThisRun: number;
  lastMessageId: string | null;
  lastTimestamp: string | null;
  lagSeconds: number | null;
  state: 'OK' | 'GAP' | 'ERROR';
  note?: string;
}

/**
 * Which conversations a status document covers.
 *
 * `run` means the conversations this run examined (a subset when the inventory
 * was truncated or a limit was set). `cumulative` means every conversation the
 * repository's checkpoint file holds. A `run` document must never be read as
 * total coverage.
 */
export type StatusScope = 'run' | 'cumulative';

/** Source-side completeness of one run, so a short run is never read as complete. */
export interface InventoryCoverage {
  /** Conversations returned and examined this run. */
  examined: number;
  /** Total conversations the source reports. */
  totalAvailable: number;
  /** True when the source holds more conversations than were examined. */
  truncated: boolean;
  /** False when the inventory scan hit the hard cap before the cursor ended. */
  inventoryComplete: boolean;
}

/** The status dashboard, written to the repo for a human to read. */
export interface SyncStatus {
  generatedAt: string;
  source: SourceKind;
  /** Whether `conversations` covers this run only or the cumulative archive. */
  scope: StatusScope;
  /** Conversation inventory coverage for this run (source-side completeness). */
  inventory: InventoryCoverage;
  conversations: ConversationStatus[];
  /** Totals for the `scope` above. */
  totals: {
    conversations: number;
    messages: number;
    gaps: number;
    errors: number;
  };
  /**
   * Cumulative messages archived across the repository's whole checkpoint file,
   * independent of how many conversations this run examined. Lets a reader see
   * "1 conversation this run, 5 archived in total" instead of a bare "1".
   */
  cumulative: {
    conversations: number;
    messages: number;
  };
  unsupportedSources: string[];
  lastSuccessfulSync: string | null;
}

/** Outcome of one sync run. */
export interface SyncRunResult {
  status: SyncStatus;
  /** Repository paths written this run (empty on a no-op). */
  written: { repository: string; path: string; commit: string | null }[];
  /** Non-fatal problems that were surfaced rather than hidden. */
  errors: string[];
}
