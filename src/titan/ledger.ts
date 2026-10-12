import { TitanTask, TaskStatus } from './types.ts';

export class MissionLedger {
  private entries: TitanTask[] = [];

  add(task: TitanTask): void {
    this.entries.push(task);
  }

  list(): TitanTask[] {
    return this.entries;
  }

  count(): number {
    return this.entries.length;
  }

  total(): number {
    return this.entries.length;
  }

  activeCount(): number {
    return this.entries.filter((entry) => entry.status === 'ACTIVE').length;
  }

  statusOf(id: string): TaskStatus | undefined {
    return this.entries.find((entry) => entry.id === id)?.status;
  }

  complete(id: string): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      throw new RangeError(`Unknown task id: ${id}`);
    }
    if (entry.status === 'DONE') {
      throw new Error('Task is already terminal');
    }
    entry.status = 'DONE';
  }
}
