import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissionLedger } from '../../src/titan/ledger.ts';
import { buildReport } from '../../src/titan/report.ts';

test('ledger tracks counts and completion', () => {
  const ledger = new MissionLedger();
  ledger.add({ id: 'a', title: 'A', status: 'ACTIVE' });
  ledger.add({ id: 'b', title: 'B', status: 'PENDING' });
  assert.equal(ledger.count(), 2);
  assert.equal(ledger.activeCount(), 1);
  ledger.complete('b');
  assert.equal(ledger.statusOf('b'), 'DONE');
});

test('report summarizes totals', () => {
  const ledger = new MissionLedger();
  ledger.add({ id: 'a', title: 'A', status: 'ACTIVE' });
  const report = buildReport(ledger);
  assert.equal(report.total, 1);
  assert.equal(report.active, 1);
});
