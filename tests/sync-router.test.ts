import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeConversation, transcriptPath, isValidRepository, type RouteRule } from '../src/sync/router.ts';

// Routing must be deterministic, metadata-driven, and must never leak one
// project's conversation into another project's repository.

const RULES: RouteRule[] = [
  { repository: 'owner/amina', selectedRepository: 'owner/Amina' },
  { repository: 'owner/baleegh', selectedRepository: 'owner/SmartFarm' },
  { repository: 'owner/firstborn', titleContains: 'conversation synchronization' },
];

test('router: a session routes to the repository it worked on', () => {
  const d = routeConversation({ conversationId: 'c1', title: 'Fix login', selectedRepository: 'owner/Amina' }, RULES, 'owner/fallback');
  assert.equal(d.repository, 'owner/amina');
  assert.equal(d.explicit, true);
});

test('router: cross-project sessions route by title metadata', () => {
  const d = routeConversation({ conversationId: 'c2', title: 'Conversation synchronization rollout', selectedRepository: null }, RULES, 'owner/fallback');
  assert.equal(d.repository, 'owner/firstborn');
  assert.match(d.matchedBy, /titleContains/);
});

test('router: an unmatched conversation uses the fallback and is marked non-explicit', () => {
  const d = routeConversation({ conversationId: 'c3', title: 'Random chat', selectedRepository: 'owner/unknown' }, RULES, 'owner/fallback');
  assert.equal(d.repository, 'owner/fallback');
  assert.equal(d.explicit, false);
});

test('router: with no fallback an unmatched conversation routes nowhere', () => {
  const d = routeConversation({ conversationId: 'c4', title: 'Random chat', selectedRepository: null }, RULES, null);
  assert.equal(d.repository, null);
  assert.equal(d.matchedBy, 'unrouted');
});

test('router: isolation — the same title never crosses repositories', () => {
  const a = routeConversation({ conversationId: 'c5', title: 'Work', selectedRepository: 'owner/Amina' }, RULES, null);
  const b = routeConversation({ conversationId: 'c6', title: 'Work', selectedRepository: 'owner/SmartFarm' }, RULES, null);
  assert.notEqual(a.repository, b.repository);
});

test('router: transcript paths are stable per conversation id', () => {
  assert.equal(transcriptPath('abc123'), 'docs/conversation-sync/transcripts/openhands/abc123.md');
  assert.equal(transcriptPath('abc123'), transcriptPath('abc123'));
});

test('router: repository validation rejects URLs and path traversal', () => {
  assert.equal(isValidRepository('owner/repo'), true);
  assert.equal(isValidRepository('https://github.com/owner/repo'), false);
  assert.equal(isValidRepository('owner/../etc'), false);
  assert.equal(isValidRepository('owner/repo/extra'), false);
});
