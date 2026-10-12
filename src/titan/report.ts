import { MissionLedger } from './ledger.ts';

export interface TitanReport {
  total: number;
  active: number;
}

export function buildReport(ledger: MissionLedger): TitanReport {
  return {
    total: ledger.count(),
    active: ledger.activeCount(),
  };
}
