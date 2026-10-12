/**
 * Read-only cross-repository audit entry point.
 * Uses GitHub's public read API only. It never clones or executes target-repository code.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

type Finding = { severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'; title: string; evidence: string[]; recommendation: string };
const target = (process.env.FORGE_TARGET_REPO || '').trim();
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Firstborn-Forge-ReadOnly-Audit' } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

async function getTextFile(owner: string, repo: string, filePath: string, ref: string): Promise<string | null> {
  try {
    const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
    const data = await getJson(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`);
    if (data.type !== 'file' || typeof data.content !== 'string') return null;
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  if (!repoPattern.test(target) || target.includes('..')) throw new Error('FORGE_TARGET_REPO must be an explicit owner/repo value.');
  const [owner, repo] = target.split('/');
  const metadata = await getJson(`https://api.github.com/repos/${owner}/${repo}`);
  const branch = metadata.default_branch;
  const commit = await getJson(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(branch)}`);
  const tree = await getJson(`https://api.github.com/repos/${owner}/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  if (!Array.isArray(tree.tree)) throw new Error('GitHub did not return a repository tree.');

  const files = tree.tree.filter((item: any) => item.type === 'blob').map((item: any) => String(item.path));
  const has = (p: string) => files.includes(p);
  const matching = (re: RegExp) => files.filter((p: string) => re.test(p));
  const findings: Finding[] = [];
  const checks: { check: string; result: 'PASS' | 'FAIL' | 'NOT_RUN'; evidence: string }[] = [];

  checks.push({ check: 'Repository metadata and default branch', result: 'PASS', evidence: `${metadata.full_name}; branch=${branch}; commit=${commit.sha}` });
  checks.push({ check: 'Recursive repository tree', result: tree.truncated ? 'FAIL' : 'PASS', evidence: `${files.length} tracked files; truncated=${Boolean(tree.truncated)}` });
  if (tree.truncated) findings.push({ severity: 'HIGH', title: 'Repository tree response was truncated', evidence: ['GitHub marked the recursive tree as truncated.'], recommendation: 'Audit directories in bounded sub-tree requests before treating the inventory as complete.' });

  const readme = files.find((p: string) => /^README(?:\.[^/]*)?$/i.test(p));
  checks.push({ check: 'README discoverability', result: readme ? 'PASS' : 'FAIL', evidence: readme || 'No root README found' });
  if (!readme) findings.push({ severity: 'LOW', title: 'Root README missing', evidence: ['No root-level README file found in the repository tree.'], recommendation: 'Add a root README documenting setup, supported checks, and project architecture.' });

  const packageJson = has('package.json');
  const gradleBuildFiles = matching(/(^|\/)(build\.gradle|build\.gradle\.kts)$/);
  const gradleWrapperScript = has('gradlew');
  const gradleWrapperJar = has('gradle/wrapper/gradle-wrapper.jar');
  const androidManifest = matching(/(^|\/)AndroidManifest\.xml$/);
  const testFiles = matching(/(^|\/)(test|tests|src\/test|src\/androidTest)(\/|\.)/i);
  const workflowFiles = matching(/^\.github\/workflows\/.*\.ya?ml$/);
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'gradle/libs.versions.toml'].filter(has);

  if (packageJson) {
    const pkgText = await getTextFile(owner, repo, 'package.json', branch);
    let scripts: string[] = [];
    try { scripts = Object.keys(JSON.parse(pkgText || '{}').scripts || {}); } catch { /* surfaced below */ }
    checks.push({ check: 'Node manifest parse and scripts', result: pkgText ? 'PASS' : 'FAIL', evidence: pkgText ? `package.json readable; scripts=${scripts.join(', ') || '(none)'}` : 'package.json exists but could not be read' });
    if (!lockfiles.some((p) => ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].includes(p))) findings.push({ severity: 'MEDIUM', title: 'No Node package lockfile detected', evidence: ['package.json exists; package-lock.json, pnpm-lock.yaml, and yarn.lock are absent.'], recommendation: 'Commit the package manager lockfile to make installs reproducible.' });
  }
  if (gradleBuildFiles.length) {
    checks.push({ check: 'Gradle build configuration inventory', result: 'PASS', evidence: gradleBuildFiles.join(', ') });
    if (!gradleWrapperScript || !gradleWrapperJar) {
      findings.push({ severity: 'HIGH', title: 'Gradle wrapper is incomplete', evidence: [`gradlew present=${gradleWrapperScript}`, `gradle/wrapper/gradle-wrapper.jar present=${gradleWrapperJar}`], recommendation: 'Restore the standard Gradle wrapper script and wrapper JAR, then run the repository’s documented Gradle checks.' });
    } else {
      checks.push({ check: 'Gradle wrapper prerequisites', result: 'PASS', evidence: 'gradlew and gradle/wrapper/gradle-wrapper.jar are present' });
    }
  }
  checks.push({ check: 'Test-file inventory', result: testFiles.length ? 'PASS' : 'FAIL', evidence: testFiles.length ? `${testFiles.length} matching test paths; examples: ${testFiles.slice(0, 8).join(', ')}` : 'No conventional test paths found' });
  if (!testFiles.length) findings.push({ severity: 'MEDIUM', title: 'No conventional test files detected', evidence: ['Repository tree contains no matching test/test-source paths.'], recommendation: 'Confirm whether tests use a nonstandard location; add automated tests for critical domain workflows if absent.' });
  checks.push({ check: 'GitHub Actions workflow inventory', result: workflowFiles.length ? 'PASS' : 'FAIL', evidence: workflowFiles.length ? workflowFiles.join(', ') : 'No .github/workflows YAML files found' });
  if (!workflowFiles.length) findings.push({ severity: 'MEDIUM', title: 'No GitHub Actions workflows detected', evidence: ['No workflow YAML files found under .github/workflows.'], recommendation: 'Add CI for build and test checks that can run reproducibly.' });

  const keyPaths = [...new Set([readme, 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'app/build.gradle', 'app/build.gradle.kts', 'gradle/wrapper/gradle-wrapper.properties', 'package.json', ...workflowFiles.slice(0, 5)].filter((p): p is string => Boolean(p && has(p))))];
  const excerpts: Record<string, string> = {};
  for (const p of keyPaths) {
    const value = await getTextFile(owner, repo, p, branch);
    if (value !== null) excerpts[p] = value.slice(0, 5000);
  }

  checks.push({ check: 'Build/test execution', result: 'NOT_RUN', evidence: 'Audit mode deliberately does not execute target-repository scripts or build configuration. Static prerequisites only; no target code was run.' });
  findings.push({ severity: 'INFO', title: 'Runtime checks intentionally not executed in read-only audit mode', evidence: ['This run only reads public GitHub metadata and file contents.'], recommendation: 'If runtime validation is required, run target checks in a separately sandboxed job with no secrets and narrowly scoped permissions.' });

  const report = {
    mode: 'READ_ONLY_AUDIT',
    targetRepository: metadata.full_name,
    visibility: metadata.private ? 'private' : 'public',
    defaultBranch: branch,
    commitSha: commit.sha,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    checks,
    findings,
    inventory: { readme, packageJson, gradleBuildFiles, gradleWrapperScript, gradleWrapperJar, androidManifest, testFileCount: testFiles.length, workflowFiles, lockfiles },
    excerpts,
    guarantees: ['No target repository writes', 'No branches, commits, pull requests, or merges created', 'No target-repository code or build scripts executed'],
  };
  const evidenceDir = path.resolve(process.cwd(), '.firstborn', 'evidence');
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(path.join(evidenceDir, 'readonly-audit.json'), JSON.stringify(report, null, 2) + '\n');
  const markdown = [
    `# Forge Read-only Audit: ${metadata.full_name}`,
    '',
    `- Default branch: ${branch}`,
    `- Audited commit: ${commit.sha}`,
    `- Tracked files: ${files.length}`,
    '- Write access used: no',
    '- Target code executed: no',
    '',
    '## Checks',
    ...checks.map((c) => `- [${c.result}] ${c.check}: ${c.evidence}`),
    '',
    '## Findings',
    ...findings.map((f) => `- **${f.severity} — ${f.title}**\n  - Evidence: ${f.evidence.join('; ')}\n  - Recommendation: ${f.recommendation}`),
    '',
    '## Guarantees',
    ...report.guarantees.map((g) => `- ${g}`),
  ].join('\n');
  await fs.writeFile(path.join(evidenceDir, 'readonly-audit.md'), markdown + '\n');
  console.log(markdown);
}

main().catch((error) => {
  console.error('[Forge read-only audit] Failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
