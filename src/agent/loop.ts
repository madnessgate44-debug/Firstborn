/**
 * M2 — The agent loop.
 *
 * Forge's original engine (`forge.ts`) is a fixed pipeline: VALIDATE -> INSPECT ->
 * PLAN -> APPLY -> TEST -> COMMIT -> PR, each stage once. It can repair inside a
 * stage, but it cannot decide WHAT TO DO NEXT. This module is the missing macro
 * loop: look -> think -> act -> observe, repeated until a goal is met.
 *
 * It is deliberately ADDITIVE and declarative. It does not perform any GitHub or
 * filesystem work itself; the caller supplies:
 *   - a `brain` (typically ModelService.chooseNextAction) that picks the next action,
 *   - a set of `tools` (adapters over the existing services),
 *   - an optional `authorize` gate (typically backed by policy.ts).
 * That keeps the loop kernel pure enough to unit-test with a scripted brain while
 * the real brain and tools are wired in by the caller.
 */

export interface ToolObservation {
  ok: boolean;
  output: string;
}

export interface AgentTool {
  name: string;
  description: string;
  /** True when the tool changes state (writes files, opens a PR, ...). */
  mutating?: boolean;
  run(input: Record<string, unknown>, ctx: LoopContext): Promise<ToolObservation>;
}

export interface AgentAction {
  tool: string;
  input?: Record<string, unknown>;
}

export interface LoopStep {
  index: number;
  action: AgentAction;
  observation: ToolObservation;
}

export interface LoopContext {
  goal: string;
  /** A bounded workspace/scratch identifier; the loop never assumes a real path. */
  workspace: string;
  step: number;
}

export type AgentBrain = (state: {
  goal: string;
  history: LoopStep[];
  tools: { name: string; description: string }[];
}) => Promise<AgentAction>;

export interface LoopLimits {
  maxSteps: number;
  maxRuntimeMs: number;
}

export type Authorization = (action: AgentAction, ctx: LoopContext) => { allowed: boolean; reason?: string };

export interface LoopResult {
  status: 'COMPLETED' | 'BLOCKED' | 'FAILED';
  steps: LoopStep[];
  reason: string;
}

/** The reserved action name that ends the loop successfully. */
export const FINISH_TOOL = 'finish';

export function loadLoopLimits(env: NodeJS.ProcessEnv = process.env): LoopLimits {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const parsed = Number.parseInt(env[name] ?? '', 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    maxSteps: int('FORGE_LOOP_MAX_STEPS', 12, 1, 100),
    maxRuntimeMs: int('FORGE_LOOP_MAX_RUNTIME_MS', 10 * 60 * 1000, 10_000, 60 * 60 * 1000),
  };
}

export interface RunLoopOptions {
  goal: string;
  tools: AgentTool[];
  brain: AgentBrain;
  limits?: LoopLimits;
  authorize?: Authorization;
  workspace?: string;
  /** Injected clock for deterministic tests. */
  now?: () => number;
  onStep?: (step: LoopStep) => void;
}

/**
 * Run the bounded agent loop. Guarantees:
 * - terminates at `maxSteps` or when the brain calls `finish`;
 * - terminates at the wall-clock ceiling;
 * - a tool error is fed back to the brain as a failed observation (recoverable),
 *   never thrown through the loop;
 * - a disallowed mutating action is refused and reported, not executed;
 * - an unknown tool is reported back so the brain can correct itself.
 */
export async function runAgentLoop(options: RunLoopOptions): Promise<LoopResult> {
  const { goal, tools, brain, authorize, workspace = 'loop' } = options;
  const limits = options.limits ?? loadLoopLimits();
  const now = options.now ?? Date.now;
  const startedAt = now();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const catalog = tools.map((t) => ({ name: t.name, description: t.description }));
  const steps: LoopStep[] = [];

  for (let step = 1; step <= limits.maxSteps; step += 1) {
    if (now() - startedAt > limits.maxRuntimeMs) {
      return { status: 'BLOCKED', steps, reason: `Runtime ceiling reached (${limits.maxRuntimeMs}ms); stopping safely.` };
    }

    let action: AgentAction;
    try {
      action = await brain({ goal, history: steps, tools: catalog });
    } catch (err) {
      return { status: 'FAILED', steps, reason: `Brain failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (!action || typeof action.tool !== 'string') {
      return { status: 'FAILED', steps, reason: 'Brain returned no usable action.' };
    }

    const ctx: LoopContext = { goal, workspace, step };

    if (action.tool === FINISH_TOOL) {
      const summary = typeof action.input?.summary === 'string' ? action.input.summary : 'Goal reported complete.';
      const observation: ToolObservation = { ok: true, output: summary };
      steps.push({ index: step, action, observation });
      return { status: 'COMPLETED', steps, reason: summary };
    }

    const tool = byName.get(action.tool);
    if (!tool) {
      const observation: ToolObservation = { ok: false, output: `Unknown tool "${action.tool}". Available: ${catalog.map((t) => t.name).join(', ')}.` };
      const s: LoopStep = { index: step, action, observation };
      steps.push(s);
      options.onStep?.(s);
      continue;
    }

    if (tool.mutating && authorize) {
      const verdict = authorize(action, ctx);
      if (!verdict.allowed) {
        const observation: ToolObservation = { ok: false, output: `Action blocked by policy: ${verdict.reason ?? 'not permitted'}` };
        const s: LoopStep = { index: step, action, observation };
        steps.push(s);
        options.onStep?.(s);
        continue;
      }
    }

    let observation: ToolObservation;
    try {
      observation = await tool.run(action.input ?? {}, ctx);
    } catch (err) {
      observation = { ok: false, output: `Tool "${action.tool}" threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    const s: LoopStep = { index: step, action, observation };
    steps.push(s);
    options.onStep?.(s);
  }

  return { status: 'BLOCKED', steps, reason: `Step ceiling reached (${limits.maxSteps}); stopping safely.` };
}
