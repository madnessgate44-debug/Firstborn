import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, normalizeEvents, extractMessageText } from '../src/sync/transcript.ts';
import type { RawEvent } from '../src/sync/types.ts';

// The transcript must preserve verbatim text and must never let a secret through.

test('transcript: redacts GitHub, OpenAI, Google and AWS tokens', () => {
  const input = [
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'key: sk-abcdefghijklmnopqrstuvwxyz1234',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'AKIAIOSFODNN7EXAMPLE',
  ].join('\n');
  const { text, redactions } = redact(input);
  assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.doesNotMatch(text, /AIzaSyA1234567890/);
  assert.doesNotMatch(text, /AKIAIOSFODNN7EXAMPLE/);
  assert.ok(redactions.length >= 4);
});

test('transcript: redacts a key/value secret but keeps the key name', () => {
  const { text } = redact('password = "hunter2hunter2hunter2"');
  assert.match(text, /password/);
  assert.doesNotMatch(text, /hunter2hunter2hunter2/);
  assert.match(text, /\[REDACTED:bearer-token\]/);
});

test('transcript: redacts a PEM private key block entirely', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
  const { text } = redact(pem);
  assert.doesNotMatch(text, /MIIEowIBAAKCAQEA/);
  assert.match(text, /\[REDACTED:private-key\]/);
});

test('transcript: ordinary prose is untouched', () => {
  const prose = 'We should route issue #131 to the Firstborn repository and keep PRs #132/#133 unmerged.';
  assert.equal(redact(prose).text, prose);
});

test('transcript: extractMessageText flattens content parts', () => {
  assert.equal(extractMessageText('plain'), 'plain');
  assert.equal(extractMessageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(extractMessageText(null), '');
});

test('transcript: only genuine messages become entries; tools and state are excluded', () => {
  const events: RawEvent[] = [
    { id: 'e1', timestamp: 't1', source: 'user', kind: 'MessageEvent', llm_message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    { id: 'e2', timestamp: 't2', source: 'agent', kind: 'ActionEvent', tool_name: 'terminal' },
    { id: 'e3', timestamp: 't3', source: 'environment', kind: 'ObservationEvent', observation: { stdout: 'x' } },
    { id: 'e4', timestamp: 't4', source: 'environment', kind: 'ConversationStateUpdateEvent', key: 'agent' },
    { id: 'e5', timestamp: 't5', source: 'assistant', kind: 'MessageEvent', llm_message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] } },
  ];
  const messages = normalizeEvents(events);
  assert.deepEqual(messages.map((m) => m.id), ['e1', 'e5']);
  assert.equal(messages[0].speaker, 'user');
  assert.equal(messages[1].speaker, 'assistant');
  assert.equal(messages[0].text, 'hello');
});

test('transcript: message ids are the source event ids, never synthesized', () => {
  const events: RawEvent[] = [
    { id: '8f8984e9-f24c-42b1-8e66-b9197011d36d', timestamp: 't1', source: 'user', llm_message: { content: 'x' } },
  ];
  assert.equal(normalizeEvents(events)[0].id, '8f8984e9-f24c-42b1-8e66-b9197011d36d');
});
