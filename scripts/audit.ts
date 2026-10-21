/**
 * forge-company audit CLI — the software company performs a read-only audit.
 *
 *   npm run audit -- madnessgate44-debug/Amina
 *
 * This drives the real company engine: one work item per audit lens, competing
 * attempts, judged on evidence (a mandatory rule is that every finding cites a
 * path that exists). Read-only; it never clones or executes the target's code.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ModelService } from '../src/company/model.ts';
import { runCompanyAudit } from '../src/company/audit-company.ts';
import { fetchRepoContext } from '../src/company/repo-context.ts';

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = (argv.find((a) => !a.startsWith('--')) || '').trim();
  if (!repoPattern.test(target) || target.includes('..')) {
    console.error('usage: npm run audit -- owner/repo [--runtime] [--local-dir=PATH] [--batch-chars=N] [--models=a,b,c]');
    process.exitCode = 2;
    return;
  }
  const runtimeEnabled = argv.includes('--runtime');
  const batchArg = argv.find((a) => a.startsWith('--batch-chars='));
  const batchChars = batchArg ? Number.parseInt(batchArg.split('=')[1], 10) : undefined;
  const localArg = argv.find((a) => a.startsWith('--local-dir='));
  const localDir = localArg ? localArg.split('=')[1] : undefined;
  const modelsArg = argv.find((a) => a.startsWith('--models='));
  const auditModels = modelsArg ? modelsArg.split('=')[1].split(',').map((m) => m.trim()).filter(Boolean) : undefined;
  const ctx = await fetchRepoContext(target);
  console.log(`[audit] ${ctx.target} @ ${ctx.commit.slice(0, 8)}; ${ctx.files.length} files; ${Object.keys(ctx.excerpts).length} excerpts`);

  const model = new ModelService();
  const info = model.getProviderInfo();
  console.log(`[audit] model: ${info.primaryProvider}; Gemini fallback configured: ${info.fallbackConfigured}`);
  console.log(`[audit] lenses read every file in full (batched); isolated runtime verification: ${runtimeEnabled ? 'ON' : 'off'}`);

  const attempts = Math.max(1, Number.parseInt(process.env.FORGE_AUDIT_ATTEMPTS ?? '', 10) || 2);
  const result = await runCompanyAudit({
    model,
    ctx,
    attemptsPerItem: attempts,
    providerInfo: info,
    batchChars,
    auditModels,
    runtime: { enabled: runtimeEnabled, localDir },
  });

  console.log('\n--- COMPANY AUDIT REPORT ---');
  console.log('Status:', result.status, '|', result.reason);
  console.log('Read in full:', result.coverage.read, 'files,', Math.round(result.coverage.bytes / 1024), 'KB');
  console.log('Winners:', result.winners.join(', ') || '(none)');
  console.log(`Models that answered: ${result.modelsUsed.length} — ${result.modelsUsed.map((m) => `${m.provider}/${m.model}`).join(', ') || '(none)'}`);
  for (const e of result.employees) console.log(`- ${e.title}: ${e.success ? `winner ${e.model}` : `FAILED (${e.note})`}`);
  for (const r of result.runtime) console.log(`- runtime ${r.name}: exit ${r.exitCode}`);
  console.log('Integrated findings:', result.findings.length);

  const outDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'company-audit.json'), JSON.stringify(result, null, 2) + '\n');
  fs.writeFileSync(path.join(outDir, 'company-audit.md'), result.markdown + '\n');
  console.log('\n' + result.markdown);
  if (result.status !== 'COMPLETED') process.exitCode = 1;
}

main().catch((err) => {
  console.error('[forge-company audit] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
