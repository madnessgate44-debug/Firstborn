/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Default routing registry and its loader.
 *
 * The registry is committed as JSON so routing is a reviewable artifact, not
 * hidden in code. Routing **fails closed**: a conversation that matches no rule
 * is routed nowhere (`fallbackRepository: null`) and reported as ERROR rather
 * than being written to a guessed repository. An unknown project must never
 * leak its transcript into another project's repository.
 *
 * The built-in default below mirrors `docs/conversation-sync/routes.json` so the
 * pipeline still fails closed if the registry cannot be read.
 */

import type { RouteRule } from './router.ts';

export const DEFAULT_ROUTES_PATH = 'docs/conversation-sync/routes.json';

export interface RoutesFile {
  version: number;
  /** Fallback repository when no rule matches; null routes nowhere (fail closed). */
  fallbackRepository: string | null;
  routes: RouteRule[];
}

export const DEFAULT_ROUTES: RoutesFile = {
  version: 1,
  // Fail closed: an unknown project is unrouted, never guessed into Firstborn.
  fallbackRepository: null,
  routes: [
    // A session that worked on a repository belongs to that repository.
    { repository: 'madnessgate44-debug/Amina', selectedRepository: 'madnessgate44-debug/Amina' },
    { repository: 'madnessgate44-debug/smart-farm', selectedRepository: 'madnessgate44-debug/smart-farm' },
    { repository: 'madnessgate44-debug/brain', selectedRepository: 'madnessgate44-debug/brain' },
    { repository: 'madnessgate44-debug/Firstborn', selectedRepository: 'madnessgate44-debug/Firstborn' },
    // Coordination sessions that span repositories live with the coordination layer.
    { repository: 'madnessgate44-debug/Firstborn', titleContains: 'conversation synchronization' },
  ],
};

/** Parse a routes file defensively; a malformed file yields the safe default. */
export function parseRoutes(text: string | null | undefined): RoutesFile {
  if (!text) return DEFAULT_ROUTES;
  try {
    const parsed = JSON.parse(text);
    const routes = Array.isArray(parsed?.routes) ? parsed.routes.filter(isRouteRule) : [];
    if (routes.length === 0) return DEFAULT_ROUTES;
    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      // A registry without an explicit fallback fails closed rather than
      // inheriting a permissive default.
      fallbackRepository: typeof parsed.fallbackRepository === 'string' ? parsed.fallbackRepository : null,
      routes,
    };
  } catch {
    return DEFAULT_ROUTES;
  }
}

function isRouteRule(r: any): r is RouteRule {
  return (
    r &&
    typeof r.repository === 'string' &&
    (typeof r.selectedRepository === 'string' ||
      typeof r.titlePrefix === 'string' ||
      typeof r.titleContains === 'string')
  );
}
