import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import {
  parseTarGz,
  searchCorpus,
  isRenderSinkClaim,
  isHardcodedSecretClaim,
  isLockfileClaim,
  isApiKeyStatusClaim,
  isLegacyPeerDepsClaim,
  isUndefinedIdentifierClaim,
  findUndefinedIdentifiers,
  verifyFinding,
  type EvidenceOutcome,
} from '../src/company/evidence.ts';
import { renderAuditMarkdown, type AuditFinding } from '../src/company/audit.ts';

/** Minimal ustar writer so the parser is proven against a real archive, not a stub. */
function tarEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'utf8');
  header.write('0000000\0', 108, 8, 'utf8');
  header.write('0000000\0', 116, 8, 'utf8');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  header.write('00000000000\0', 136, 12, 'utf8');
  header.write('        ', 148, 8, 'utf8'); // checksum placeholder (spaces)
  header.write('0', 156, 1, 'utf8');
  header.write('ustar\0', 257, 6, 'utf8');
  header.write('00', 263, 2, 'utf8');
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([header, data, pad]);
}

function tarGz(files: Record<string, string>): Buffer {
  const parts = Object.entries(files).map(([p, c]) => tarEntry(`owner-repo-abc123/${p}`, c));
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

const FILES = {
  'src/App.tsx': "export default function App() { return <p>{record.notes}</p>; }",
  'server.ts': "const apiKey = process.env.GEMINI_API_KEY;\napp.get('/api/health', (_r,res)=>res.json({hasApiKey:Boolean(apiKey)}));",
  'package.json': '{ "dependencies": { "react": "^19.0.1" } }',
};

test('evidence: parses a real tar.gz into a path→text map', () => {
  const corpus = parseTarGz(tarGz(FILES));
  assert.deepEqual(Object.keys(corpus).sort(), Object.keys(FILES).sort());
  assert.match(corpus['server.ts'], /GEMINI_API_KEY/);
});

test('evidence: searchCorpus finds needles with path and line', () => {
  const corpus = parseTarGz(tarGz(FILES));
  const hits = searchCorpus(corpus, 'process.env');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'server.ts');
  assert.equal(hits[0].line, 1);
});

test('evidence: an XSS claim with no HTML sink is CONTRADICTED', () => {
  const corpus = parseTarGz(tarGz(FILES));
  const out = verifyFinding(
    { title: 'Stored XSS via unsanitized content', evidence: 'notes are rendered without sanitization', recommendation: 'sanitize', paths: ['src/App.tsx'] },
    corpus,
    3
  );
  assert.equal(out.verdict, 'CONTRADICTED');
  assert.equal(out.category, 'verified-fact');
  const sink = out.checks.find((c) => c.claim.includes('HTML sink'))!;
  assert.match(sink.result, /0 matches/);
  assert.equal(sink.needle, 'dangerouslySetInnerHTML');
});

test('evidence: an XSS claim WITH a real sink is SUPPORTED', () => {
  const corpus = parseTarGz(tarGz({ 'src/x.tsx': 'return <div dangerouslySetInnerHTML={{__html: notes}} />;' }));
  const out = verifyFinding(
    { title: 'XSS', evidence: 'renders raw html', recommendation: '', paths: ['src/x.tsx'] },
    corpus,
    1
  );
  assert.equal(out.verdict, 'SUPPORTED');
  assert.match(out.checks.find((c) => c.claim.includes('HTML sink'))!.result, /match/);
});

test('evidence: a hardcoded-key claim is CONTRADICTED when only env is used', () => {
  const corpus = parseTarGz(tarGz(FILES));
  const out = verifyFinding(
    { title: 'Hardcoded API key', evidence: 'a hardcoded key is committed in the source', recommendation: 'use env', paths: ['server.ts'] },
    corpus,
    3
  );
  assert.equal(out.verdict, 'CONTRADICTED');
  assert.match(out.checks.find((c) => c.claim.includes('literal credential'))!.result, /0 literals/);
});

test('evidence: a hardcoded-key claim is SUPPORTED when a literal is present', () => {
  const corpus = parseTarGz(tarGz({ 'src/k.ts': "const k = 'AIzaSyA1234567890abcdefghijklmnopqrs';" }));
  const out = verifyFinding(
    { title: 'Hardcoded key', evidence: 'hardcoded credential committed', recommendation: '', paths: ['src/k.ts'] },
    corpus,
    1
  );
  assert.equal(out.verdict, 'SUPPORTED');
});

test('evidence: an unfalsifiable claim is labeled judgment, not a fact', () => {
  const corpus = parseTarGz(tarGz(FILES));
  const out = verifyFinding(
    { title: 'Business logic in entrypoint', evidence: 'logic is coupled', recommendation: 'extract', paths: ['server.ts'] },
    corpus,
    3
  );
  assert.equal(out.verdict, 'UNVERIFIED');
  assert.equal(out.category, 'judgment');
});

test('evidence: claim detectors fire on the right words', () => {
  assert.ok(isRenderSinkClaim('potential stored cross-site scripting'));
  assert.ok(!isRenderSinkClaim('missing lockfile'));
  assert.ok(isHardcodedSecretClaim('hardcoded API key committed in source'));
  assert.ok(!isHardcodedSecretClaim('the API key is read from the environment'));
  assert.ok(isLockfileClaim('Missing package lockfile leads to non-deterministic installs'));
  assert.ok(!isLockfileClaim('business logic in the entrypoint'));
  assert.ok(isApiKeyStatusClaim('Exposed API Key Status in Health Check hasApiKey'));
  assert.ok(isLegacyPeerDepsClaim('CI uses --legacy-peer-deps'));
  assert.ok(isUndefinedIdentifierClaim('calls an undefined identifier'));
  assert.ok(isUndefinedIdentifierClaim('throws a ReferenceError at runtime'));
  assert.ok(!isUndefinedIdentifierClaim('business logic in the entrypoint'));
});

test('evidence: an undefined-identifier scan finds a call to a name declared nowhere', () => {
  const hits = findUndefinedIdentifiers({
    'src/x.tsx': "import { useState } from 'react';\nexport function X() {\n  const [n] = useState(0);\n  return <b onClick={() => setActiveStageLessonId('a')}>{n}</b>;\n}\n",
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, 'setActiveStageLessonId');
  assert.equal(hits[0].line, 4);
});

test('evidence: the scan ignores comments, strings, JSX text, globals, and definitions', () => {
  const hits = findUndefinedIdentifiers({
    'src/y.tsx': [
      "import React from 'react';",
      "// Vocab (1) is a comment, not a call",
      "const msg = 'All Subjects (5) and Vocab (2)';",
      "export class S {",
      "  public startListening(a: string): void {}",
      "}",
      "export function ok() { console.log(msg, new Date()); }",
    ].join('\n'),
  });
  assert.deepEqual(hits, []);
});

test('evidence: an undefined-identifier claim is CONFIRMED against a real bad call', () => {
  const corpus = parseTarGz(tarGz({
    'src/bad.tsx': "export const b = () => setActiveStageLessonId('lesson-1');\n",
  }));
  const out = verifyFinding(
    { title: 'Undefined identifier crashes the lesson handoff', evidence: 'calls setActiveStageLessonId which is not defined in this file', recommendation: 'define or import it', paths: ['src/bad.tsx'] },
    corpus,
    1
  );
  assert.equal(out.verdict, 'SUPPORTED');
  assert.match(out.checks.find((c) => c.claim.includes('never declared'))!.result, /setActiveStageLessonId\(/);
});

test('evidence: an undefined-identifier claim is CONTRADICTED when every call resolves', () => {
  const corpus = parseTarGz(tarGz(FILES));
  const out = verifyFinding(
    { title: 'Undefined identifier in the app', evidence: 'an undefined identifier is called', recommendation: '', paths: ['src/App.tsx'] },
    corpus,
    3
  );
  assert.equal(out.verdict, 'CONTRADICTED');
  assert.match(out.checks.find((c) => c.claim.includes('never declared'))!.result, /0 suspect calls/);
});

test('evidence: a missing-lockfile claim is CONFIRMED when no lockfile exists', () => {
  const corpus = parseTarGz(tarGz(FILES));
  const out = verifyFinding(
    { title: 'Missing package lockfile for deterministic builds', evidence: 'no package-lock.json is present', recommendation: 'commit one', paths: ['package.json'] },
    corpus,
    3
  );
  assert.equal(out.verdict, 'SUPPORTED');
  assert.match(out.checks.find((c) => c.claim.includes('lockfile is present'))!.result, /none of/);
});

test('evidence: a missing-lockfile claim is CONTRADICTED when a lockfile exists', () => {
  const corpus = parseTarGz(tarGz({ ...FILES, 'package-lock.json': '{}' }));
  const out = verifyFinding(
    { title: 'Missing lockfile', evidence: 'no lockfile', recommendation: '', paths: ['package.json'] },
    corpus,
    4
  );
  assert.equal(out.verdict, 'CONTRADICTED');
});

test('evidence: a hasApiKey exposure claim is CONFIRMED when the field exists', () => {
  const corpus = parseTarGz(tarGz(FILES));
  const out = verifyFinding(
    { title: 'Exposed API Key Status in Health Check', evidence: '/api/health returns hasApiKey: Boolean(apiKey)', recommendation: 'remove it', paths: ['server.ts'] },
    corpus,
    3
  );
  assert.equal(out.verdict, 'SUPPORTED');
  assert.match(out.checks.find((c) => c.claim.includes('exposes whether'))!.result, /match/);
});

test('evidence: a legacy-peer-deps claim is CONFIRMED against the workflow text', () => {
  const corpus = parseTarGz(tarGz({ ...FILES, '.github/workflows/deploy-pages.yml': 'run: npm install --legacy-peer-deps' }));
  const out = verifyFinding(
    { title: 'CI uses --legacy-peer-deps', evidence: 'deploy-pages.yml installs with --legacy-peer-deps', recommendation: 'resolve peers', paths: ['.github/workflows/deploy-pages.yml'] },
    corpus,
    4
  );
  assert.equal(out.verdict, 'SUPPORTED');
});

test('render: splits findings into verified / judgment / withdrawn with spot-check links', () => {
  const findings: AuditFinding[] = [
    { severity: 'HIGH', title: 'Missing lockfile', paths: ['package.json'], basis: 'inferred', evidence: 'no lockfile', recommendation: 'commit one', raisedBy: 'Quality' },
    { severity: 'HIGH', title: 'Stored XSS', paths: ['src/App.tsx'], basis: 'observed', evidence: 'unsanitized', recommendation: 'sanitize', raisedBy: 'Security' },
    { severity: 'MEDIUM', title: 'Business logic in server', paths: ['server.ts'], basis: 'observed', evidence: 'coupled', recommendation: 'extract', raisedBy: 'Arch' },
  ];
  const evidence: Record<string, EvidenceOutcome> = {
    'Missing lockfile': { verdict: 'SUPPORTED', category: 'verified-fact', checks: [{ claim: 'lockfile absent', command: 'git ls-files', result: '0 matches', supports: true, needle: 'package-lock.json' }] },
    'Stored XSS': { verdict: 'CONTRADICTED', category: 'verified-fact', checks: [{ claim: 'an unsafe HTML sink exists', command: 'grep', result: '0 matches across 3 files', supports: false, needle: 'dangerouslySetInnerHTML' }] },
    'Business logic in server': { verdict: 'UNVERIFIED', category: 'judgment', checks: [] },
  };
  const md = renderAuditMarkdown({
    target: 'acme/repo', commit: 'abc123', fileCount: 3, employees: [], findings, evidence,
    evidenceSummary: { verified: 1, contradicted: 1, judgment: 1 },
  });
  assert.match(md, /## Verified facts[\s\S]*Missing lockfile/);
  assert.match(md, /## Judgment calls \(opinions, not proven\)[\s\S]*Business logic in server/);
  assert.match(md, /## Withdrawn by evidence[\s\S]*Stored XSS/);
  assert.match(md, /Spot-check yourself/);
  assert.match(md, /Verified facts: \*\*1\*\*/);
  assert.match(md, /Withdrawn by evidence: \*\*1\*\*/);
  // The withdrawn finding must not appear under Verified facts.
  const verifiedSection = md.split('## Verified facts')[1].split('## Judgment calls')[0];
  assert.doesNotMatch(verifiedSection, /Stored XSS/);
});
