import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { routeConversation } from '../src/sync/router.ts';
import { DEFAULT_ROUTES, DEFAULT_ROUTES_PATH, parseRoutes } from '../src/sync/routes.ts';

// The committed registry is a routing contract: the intended projects must route
// to their own repositories, and an unknown project must fail closed. These tests
// read the real file so a change to it cannot silently break isolation.

const registryText = readFileSync(new URL(`../${DEFAULT_ROUTES_PATH}`, import.meta.url), 'utf8');
const registry = parseRoutes(registryText);

test('routes registry: the committed file parses and fails closed', () => {
  assert.ok(registry.routes.length >= 3, 'registry must list the known projects');
  assert.equal(registry.fallbackRepository, null, 'an unknown project must route nowhere');
});

test('routes registry: Amina and SmartFarm route to their own repositories', () => {
  const amina = routeConversation(
    { conversationId: 'a', title: 'Amina work', selectedRepository: 'madnessgate44-debug/Amina' },
    registry.routes,
    registry.fallbackRepository
  );
  const smartFarm = routeConversation(
    { conversationId: 's', title: 'Baleegh work', selectedRepository: 'madnessgate44-debug/smart-farm' },
    registry.routes,
    registry.fallbackRepository
  );
  assert.equal(amina.repository, 'madnessgate44-debug/Amina');
  assert.equal(smartFarm.repository, 'madnessgate44-debug/smart-farm');
  assert.notEqual(amina.repository, smartFarm.repository);
});

test('routes registry: an unknown project is unrouted, not guessed into Firstborn', () => {
  const decision = routeConversation(
    { conversationId: 'x', title: 'Some new project', selectedRepository: 'madnessgate44-debug/Unknown' },
    registry.routes,
    registry.fallbackRepository
  );
  assert.equal(decision.repository, null);
  assert.equal(decision.matchedBy, 'unrouted');
});

test('routes registry: the built-in default matches the committed file (fail closed)', () => {
  assert.equal(DEFAULT_ROUTES.fallbackRepository, null);
  assert.deepEqual(
    DEFAULT_ROUTES.routes.map((r) => `${r.repository}|${r.selectedRepository ?? r.titleContains ?? ''}`).sort(),
    registry.routes.map((r) => `${r.repository}|${r.selectedRepository ?? r.titleContains ?? ''}`).sort()
  );
});
