export type TaskStatus = 'PENDING' | 'ACTIVE' | 'DONE';

export interface TitanTask {
  id: string;
  title: string;
  status: TaskStatus;
}
