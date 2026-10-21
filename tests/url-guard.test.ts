import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl } from '../src/services/url-guard.ts';

// Every case uses an IP literal, so the guard never needs DNS and the tests never
// touch the network. A hostname would make the result depend on the resolver.

test('url-guard: file:// is blocked', async () => {
  await assert.rejects(() => assertPublicHttpUrl('file:///etc/passwd'), /Only http\(s\) URLs are allowed/);
});

test('url-guard: the cloud metadata address is blocked', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://169.254.169.254/latest/meta-data/'), /blocked/);
});

test('url-guard: private ranges are blocked', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://10.0.0.1/'), /blocked/);
  await assert.rejects(() => assertPublicHttpUrl('http://192.168.1.1/'), /blocked/);
});

test('url-guard: loopback is blocked by default and allowed when asked', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://127.0.0.1:3000/'), /blocked/);
  const allowed = await assertPublicHttpUrl('http://127.0.0.1:3000/', { allowLoopback: true });
  assert.equal(allowed.hostname, '127.0.0.1');
});

test('url-guard: IPv6 loopback is blocked by default and allowed when asked', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://[::1]:3000/'), /blocked/);
  const allowed = await assertPublicHttpUrl('http://[::1]:3000/', { allowLoopback: true });
  assert.equal(allowed.hostname, '[::1]');
});

test('url-guard: an IPv4-mapped IPv6 private address is blocked', async () => {
  await assert.rejects(() => assertPublicHttpUrl('http://[::ffff:10.0.0.1]/'), /blocked/);
});

test('url-guard: a public address is allowed', async () => {
  const allowed = await assertPublicHttpUrl('https://93.184.216.34/');
  assert.equal(allowed.protocol, 'https:');
  assert.equal(allowed.hostname, '93.184.216.34');
});
