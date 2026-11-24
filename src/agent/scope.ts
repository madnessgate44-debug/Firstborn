/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mission scope partition.
 *
 * A Forge mission declares its intended file scope through the model's planned
 * changes. Tools that run inside the worktree (for example `npm install`) can
 * modify files outside that scope, such as lockfiles. Those changes are real
 * and must not be silently discarded, but they also must not be blended into
 * the exported patch as if the model authored them. This module separates the
 * two sets deterministically so the exporter can ship the in-scope patch and
 * flag the out-of-scope drift for review.
 *
 * Pure and deterministic: no I/O, no model, no network.
 */

export interface ScopePartition {
  /** Changed files that are part of the mission's planned scope. */
  inScope: string[];
  /** Changed files outside the planned scope (tool-induced or unexpected edits). */
  outOfScope: string[];
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/');
}

/**
 * Partition changed files against the mission's planned paths.
 * Comparison is exact on normalized relative paths; a planned path with no
 * detected change simply contributes nothing.
 */
export function partitionScopeDiff(plannedPaths: string[], changedFiles: string[]): ScopePartition {
  const planned = new Set(plannedPaths.map(normalizePath));
  const inScope: string[] = [];
  const outOfScope: string[] = [];
  for (const raw of changedFiles) {
    const file = normalizePath(raw);
    (planned.has(file) ? inScope : outOfScope).push(file);
  }
  return { inScope, outOfScope };
}
