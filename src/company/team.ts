/**
 * Teams: an ordered roster that works one job together.
 *
 * Each role runs the hardened loop with its own mandate, tools and authority,
 * then posts its artifact to the shared bus. Later roles read what earlier roles
 * produced, which is how the employees "integrate" — the handoff is explicit and
 * typed, never implicit.
 */
import { runAgentLoop, FINISH_TOOL, type AgentAction, type LoopLimits } from '../kernel/loop.ts';
import type { ArtifactBus } from './bus.ts';
import type { Role, RoleInput, RoleResult } from './roles.ts';

export interface TeamRun {
  workItem: string;
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED';
  reason: string;
  results: { role: string; result: RoleResult }[];
  /** Files under change after the team ran (for downstream judging). */
  changes: Record<string, string>;
}

export interface TeamOptions {
  /** The whole-company goal. */
  goal: string;
  /** The work item this team owns. */
  workItem: string;
  /** The scope id for artifacts (usually `${workItem}#${attempt}`). */
  scope: string;
  /** The ordered roster. */
  roster: Role[];
  /** Shared artifact bus. */
  bus: ArtifactBus;
  limits?: LoopLimits;
  /** Files under change; a mutating role may add to this. */
  changes?: Record<string, string>;
  /** Stop the whole team if a role fails (default: true for producers of change). */
  stopOnFailure?: boolean;
}

/** Derive a role result from the loop's terminal action. */
function interpret(role: Role, actions: AgentAction[], status: string, reason: string): RoleResult {
  const finish = [...actions].reverse().find((a) => a.tool === FINISH_TOOL);
  const data = (finish?.input?.data as Record<string, unknown> | undefined) ?? {};
  const summary = (finish?.input?.summary as string | undefined) ?? reason;
  return {
    ok: status === 'COMPLETED',
    kind: role.produces,
    summary,
    data,
    steps: actions.length,
    reason: status === 'COMPLETED' ? undefined : reason,
  };
}

export async function runTeam(options: TeamOptions): Promise<TeamRun> {
  const { goal, workItem, scope, roster, bus } = options;
  const stopOnFailure = options.stopOnFailure ?? true;
  const changes: Record<string, string> = { ...(options.changes ?? {}) };
  const results: { role: string; result: RoleResult }[] = [];

  for (const role of roster) {
    const input: RoleInput = {
      goal,
      workItem,
      scope,
      artifacts: bus.forScope(scope),
      changes: { ...changes },
    };

    const loop = await runAgentLoop({
      goal: `${role.title}: ${role.mandate} [${workItem}]`,
      tools: role.tools,
      brain: (state) => role.brain({ ...state, memory: state.memory }),
      authorize: role.authorize,
      limits: role.limits ?? options.limits,
      workspace: scope,
      memory: JSON.stringify(input.artifacts.map((a) => ({ kind: a.kind, author: a.author, summary: a.summary }))),
      verifyCompletion: role.verifyCompletion,
    });

    const result = interpret(role, loop.steps.map((s) => s.action), loop.status, loop.reason);
    bus.post({ kind: role.produces, author: role.id, scope, summary: result.summary, data: result.data });
    results.push({ role: role.id, result });

    // A mutating role records the files it changed. `files` must be a path->content
    // map; a plain list of touched names (e.g. from a design) is not a change.
    const wrote = result.data.files;
    if (wrote && typeof wrote === 'object' && !Array.isArray(wrote)) {
      Object.assign(changes, wrote as Record<string, string>);
    }

    if (!result.ok && stopOnFailure) {
      return { workItem, status: 'BLOCKED', reason: `${role.id} failed: ${result.reason ?? result.summary}`, results, changes };
    }
  }

  const failed = results.some((r) => !r.result.ok);
  return {
    workItem,
    status: failed ? 'BLOCKED' : 'COMPLETED',
    reason: failed ? 'one or more roles failed' : 'team completed the work item',
    results,
    changes,
  };
}
