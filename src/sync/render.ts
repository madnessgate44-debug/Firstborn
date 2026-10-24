/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render the durable artifacts.
 *
 * Two artifacts are kept strictly separate, as the sync protocol requires:
 *   - the transcript: source-faithful messages, verbatim and ordered;
 *   - the status: coverage, last successful sync, lag and gaps.
 *
 * The transcript format is lossless: each message body is wrapped in a code fence
 * whose length exceeds any backtick run inside the text, and the parser removes
 * exactly one newline from each side of the body. Trailing spaces and blank lines
 * inside a message therefore survive a write-then-read-back round trip byte for
 * byte, which is what "verbatim" has to mean.
 */

import type { SyncStatus, TranscriptMessage } from './types.ts';

export interface TranscriptHeader {
  conversationId: string;
  repository: string;
  title: string | null;
  sourceUrl: string | null;
  lastTimestamp: string | null;
  messageCount: number;
}

/** A fence longer than any backtick run in the body, so the body cannot close it. */
export function fenceFor(text: string): string {
  let longest = 0;
  let run = 0;
  for (const ch of text) {
    if (ch === '`') {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Render one conversation transcript as Markdown. */
export function renderTranscript(header: TranscriptHeader, messages: TranscriptMessage[]): string {
  const lines: string[] = [];
  lines.push(`# OpenHands Conversation Transcript — ${header.conversationId}`);
  lines.push('');
  lines.push('- Source: OpenHands Cloud session (API V1 event stream)');
  lines.push(`- Conversation ID: \`${header.conversationId}\``);
  lines.push(`- Title: ${header.title ?? '(untitled)'}`);
  lines.push(`- Repository: \`${header.repository}\``);
  if (header.sourceUrl) lines.push(`- Conversation UI: ${header.sourceUrl}`);
  lines.push(`- Messages archived: ${header.messageCount}`);
  lines.push(`- Last message timestamp: ${header.lastTimestamp ?? '(none)'}`);
  lines.push('- Capture method: unattended API read; verbatim text, secrets redacted');
  lines.push('- Status: **COMPLETE** for the messages listed (source is paginated in full)');
  lines.push('');
  lines.push('> Verbatim messages only. Tool actions, observations, and state updates are not');
  lines.push('> conversation text and are excluded. Redactions appear as `[REDACTED:<kind>]`.');
  lines.push('');
  for (const m of messages) {
    const fence = fenceFor(m.text);
    lines.push(`## ${m.speaker} — ${m.timestamp} — \`${m.id}\``);
    lines.push('');
    lines.push(fence);
    lines.push(m.text);
    lines.push(fence);
    lines.push('');
  }
  return lines.join('\n');
}

/** Render the status dashboard as Markdown. */
export function renderStatus(status: SyncStatus): string {
  const lines: string[] = [];
  lines.push('# Conversation Sync Status');
  lines.push('');
  lines.push(`- Generated: ${status.generatedAt}`);
  lines.push(`- Source: ${status.source}`);
  lines.push(`- Last successful sync: ${status.lastSuccessfulSync ?? '(never)'}`);
  lines.push(`- Scope: **${status.scope}** — this file lists the conversations ${scopeExplanation(status.scope)}`);
  lines.push(
    `- Inventory: examined ${status.inventory.examined} of ${status.inventory.totalAvailable} conversation(s)` +
      (status.inventory.truncated ? ' — **TRUNCATED**: more conversations exist than were examined' : '') +
      (status.inventory.inventoryComplete ? '' : ' — inventory scan incomplete')
  );
  lines.push(
    `- Totals (this run): ${status.totals.conversations} conversations, ${status.totals.messages} messages, ` +
      `${status.totals.gaps} gaps, ${status.totals.errors} errors`
  );
  lines.push(
    `- Cumulative archive: ${status.cumulative.conversations} conversations, ${status.cumulative.messages} messages`
  );
  lines.push('');
  lines.push('## Conversations');
  lines.push('');
  lines.push('| Conversation | Repository | Messages (total) | Added this run | Lag (s) | State | Note |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of status.conversations) {
    lines.push(
      `| \`${c.conversationId}\` | \`${c.repository}\` | ${c.messageCount} | ${c.addedThisRun} | ` +
        `${c.lagSeconds ?? '—'} | ${c.state} | ${c.note ?? ''} |`
    );
  }
  lines.push('');
  lines.push('## Unsupported sources');
  lines.push('');
  if (status.unsupportedSources.length === 0) {
    lines.push('(none)');
  } else {
    for (const s of status.unsupportedSources) lines.push(`- ${s}`);
  }
  lines.push('');
  return lines.join('\n');
}

function scopeExplanation(scope: SyncStatus['scope']): string {
  return scope === 'run'
    ? 'examined by this run only; a short run is not total coverage'
    : 'held in this repository\'s checkpoint file in total';
}

/** The machine-readable status document. */
export function renderStatusJson(status: SyncStatus): string {
  return JSON.stringify(status, null, 2) + '\n';
}
