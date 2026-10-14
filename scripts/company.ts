/**
 * forge-company CLI — run the company on a goal.
 *
 * With no model configured, the company runs with deterministic scripted
 * employees so the org mechanics (teams, competition, judging, integration) are
 * exercisable and auditable without any LLM. A model-backed roster plugs in at
 * the same `rosterFor` boundary.
 */
import { ArtifactBus } from '../src/company/bus.ts';
import { runCompany } from '../src/company/company.ts';
import { DEFAULT_ROSTER } from '../src/company/roles.ts';
import type { Role } from '../src/company/roles.ts';
import type { AgentAction, AgentBrain } from '../src/kernel/loop.ts';

/** Role-appropriate demo artifacts, so the demo shows a real winning competition. */
function demoData(id: string, attempt: number): Record<string, unknown> {
  switch (id) {
    case 'pm':
      return { items: ['acceptance criteria 1', 'acceptance criteria 2'] };
    case 'architect':
      return { design: 'a small, reversible change', files: ['src/feature.ts'] };
    case 'implementer':
      return { files: { 'src/feature.ts': `// attempt ${attempt}\nexport const feature = true;\n` } };
    case 'reviewer':
      return { blockers: 0, notes: ['looks correct'] };
    case 'qa':
      return { checks: [{ name: 'test', status: 'PASSED' }, { name: 'lint', status: 'PASSED' }] };
    case 'security':
      return { clean: true, findings: [] };
    case 'release':
      return { ship: true };
    default:
      return {};
  }
}

function scriptedBrain(id: string, attempt: number): AgentBrain {
  const script: AgentAction[] = [
    { tool: 'think', input: { thought: `${id} plans the work` } },
    { tool: 'finish', input: { summary: `${id} completed its mandate`, data: demoData(id, attempt) } },
  ];
  let i = 0;
  return async () => script[Math.min(i++, script.length - 1)];
}

function scriptedRoster(attempt: number): Role[] {
  return DEFAULT_ROSTER.map((r) => ({
    id: r.id,
    title: r.title,
    mandate: r.mandate,
    authority: r.authority,
    consumes: r.consumes,
    produces: r.produces,
    tools: [{ name: 'think', description: 'noop', run: async () => ({ ok: true, output: 'ok' }) }],
    brain: scriptedBrain(r.id, attempt),
  }));
}

async function main(): Promise<void> {
  const goal = process.argv.slice(2).join(' ').trim() || 'Demonstrate the company on a sample goal.';
  const bus = new ArtifactBus();
  const result = await runCompany({
    goal,
    bus,
    plan: (g) => [{ id: 'w1', title: g }],
    rosterFor: (_item, attempt) => scriptedRoster(attempt),
    attemptsPerItem: 2,
  });

  console.log('--- FORGE COMPANY REPORT ---');
  console.log('Goal:', result.goal);
  console.log('Status:', result.status);
  console.log('Reason:', result.reason);
  console.log('Winners:', result.winners.join(', ') || '(none)');
  console.log('Artifacts:', bus.all().length);
  for (const item of result.items) {
    console.log(`- ${item.item.title}: ${item.competition.reason}`);
    for (const card of item.competition.scorecards) {
      console.log(`    ${card.attempt}: ${card.total} pt(s)${card.eligible ? '' : ' [ineligible]'}`);
    }
  }
  if (result.status !== 'COMPLETED') process.exitCode = 1;
}

main().catch((err) => {
  console.error('[forge-company] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
