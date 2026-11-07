/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Project/repository routing.
 *
 * A conversation is archived into the repository of the project it belongs to,
 * decided from stable source metadata — never from free text. The registry is an
 * explicit, ordered list so routing is deterministic and testable, and a
 * conversation that matches nothing routes to a configured fallback (or nowhere,
 * if no fallback is set) rather than being written to a guessed repository.
 */

export interface RouteRule {
  /** Repository to route to, `owner/repo`. */
  repository: string;
  /** Match a conversation's `selected_repository` exactly. */
  selectedRepository?: string;
  /** Match a conversation title prefix (case-insensitive), e.g. "GitHub Issue #131". */
  titlePrefix?: string;
  /** Match a substring of the title (case-insensitive). */
  titleContains?: string;
}

export interface RouteInput {
  conversationId: string;
  title: string | null;
  selectedRepository: string | null;
}

export interface RouteDecision {
  repository: string | null;
  /** Which rule matched, or `fallback`, or `unrouted`. */
  matchedBy: string;
  /** True when the decision came from an explicit rule, not the fallback. */
  explicit: boolean;
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidRepository(repo: string): boolean {
  return REPO_PATTERN.test(repo) && !repo.includes('..');
}

/**
 * Decide the destination repository for a conversation.
 *
 * Rules are evaluated in order and the first match wins, so a more specific rule
 * must be listed before a general one. `selected_repository` is preferred because
 * it is the repository the session actually worked on; title rules exist for
 * coordination conversations that span repositories.
 */
export function routeConversation(
  input: RouteInput,
  rules: RouteRule[],
  fallback: string | null = null
): RouteDecision {
  for (const rule of rules) {
    if (rule.selectedRepository && input.selectedRepository === rule.selectedRepository) {
      return { repository: rule.repository, matchedBy: `selectedRepository=${rule.selectedRepository}`, explicit: true };
    }
    const title = input.title ?? '';
    if (rule.titlePrefix && title.toLowerCase().startsWith(rule.titlePrefix.toLowerCase())) {
      return { repository: rule.repository, matchedBy: `titlePrefix=${rule.titlePrefix}`, explicit: true };
    }
    if (rule.titleContains && title.toLowerCase().includes(rule.titleContains.toLowerCase())) {
      return { repository: rule.repository, matchedBy: `titleContains=${rule.titleContains}`, explicit: true };
    }
  }
  if (fallback) return { repository: fallback, matchedBy: 'fallback', explicit: false };
  return { repository: null, matchedBy: 'unrouted', explicit: false };
}

/** Repository path for a conversation's transcript, stable per conversation id. */
export function transcriptPath(conversationId: string): string {
  return `docs/conversation-sync/transcripts/openhands/${conversationId}.md`;
}
