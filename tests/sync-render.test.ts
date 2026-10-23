import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTranscript, fenceFor } from '../src/sync/render.ts';
import { parseTranscriptMessages } from '../src/sync/pipeline.ts';
import type { TranscriptMessage } from '../src/sync/types.ts';

// The transcript must round-trip byte for byte. This was a real bug: the first
// parser trimmed trailing whitespace, so a live read-back found one message whose
// final space had been dropped. These tests pin lossless fidelity.

function roundTrip(messages: TranscriptMessage[]): TranscriptMessage[] {
  const md = renderTranscript(
    { conversationId: 'c1', repository: 'o/r', title: 'T', sourceUrl: null, lastTimestamp: messages.at(-1)?.timestamp ?? null, messageCount: messages.length },
    messages
  );
  return parseTranscriptMessages(md);
}

test('render: a message with trailing spaces survives a round trip exactly', () => {
  const messages: TranscriptMessage[] = [
    { id: 'm1', speaker: 'user', timestamp: 't1', text: 'trailing space at the end ' },
    { id: 'm2', speaker: 'assistant', timestamp: 't2', text: 'leading and trailing\n\nblank lines\n' },
  ];
  const parsed = roundTrip(messages);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].text, 'trailing space at the end ');
  assert.equal(parsed[1].text, 'leading and trailing\n\nblank lines\n');
});

test('render: text containing a code fence is preserved (fence grows past it)', () => {
  const text = 'here is a fence:\n```\ncode\n```\nand more';
  const parsed = roundTrip([{ id: 'm1', speaker: 'user', timestamp: 't1', text }]);
  assert.equal(parsed[0].text, text);
  // The chosen fence must be longer than the longest run inside the body.
  assert.ok(fenceFor(text).length > 3);
});

test('render: a four-backtick run inside the body is also safe', () => {
  const text = 'nested ```` four backticks';
  assert.ok(fenceFor(text).length >= 5);
  assert.equal(roundTrip([{ id: 'm1', speaker: 'user', timestamp: 't1', text }])[0].text, text);
});

test('render: ids, order and timestamps survive the round trip', () => {
  const messages: TranscriptMessage[] = [
    { id: 'id-a', speaker: 'user', timestamp: '2026-01-01T00:00:00Z', text: 'a' },
    { id: 'id-b', speaker: 'assistant', timestamp: '2026-01-01T00:01:00Z', text: 'b' },
    { id: 'id-c', speaker: 'system', timestamp: '2026-01-01T00:02:00Z', text: 'c' },
  ];
  const parsed = roundTrip(messages);
  assert.deepEqual(parsed.map((p) => p.id), ['id-a', 'id-b', 'id-c']);
  assert.deepEqual(parsed.map((p) => p.timestamp), messages.map((m) => m.timestamp));
  assert.deepEqual(parsed.map((p) => p.speaker), ['user', 'assistant', 'system']);
});

test('render: a hand-edited file without fences is skipped, not guessed', () => {
  const broken = '# Transcript\n\n## user — t1 — `m1`\n\nplain text with no fence\n';
  assert.deepEqual(parseTranscriptMessages(broken), []);
});
