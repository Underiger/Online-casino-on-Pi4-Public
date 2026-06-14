import { z } from 'zod';
import { SlotSymbol, TaskType } from '../enums';

// ── Requests ─────────────────────────────────────────────────────────────────

export const ClaimTaskReqSchema = z.object({
  taskId: z.string().min(1),
});
export type ClaimTaskReq = z.infer<typeof ClaimTaskReqSchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface DailyLoginRes {
  reward: string;        // BigInt → string，本次實際發放（含連續係數）
  streak: number;        // 本次登入後的連續天數
  multiplier: number;    // 本次係數（1.0–2.0）
  newBalance: string;
}

export interface DailyTaskItem {
  id: string;            // UserDailyProgress.id
  taskId: string;
  code: string;
  name: string;
  type: TaskType;
  target: number;
  progress: number;
  claimed: boolean;
  claimedAt: string | null;
  rewardCoin: string;    // BigInt → string
  rewardCharm: boolean;  // true 表示完成後可抽取護符
}

export interface DailyTasksRes {
  tasks: DailyTaskItem[];
  /** 今日幸運符號（null 代表尚未設定） */
  luckySymbol: SlotSymbol | null;
  dateKey: string; // "YYYY-MM-DD" (Asia/Taipei)
}

export interface ClaimTaskRes {
  taskId: string;
  coin: string;         // BigInt → string
  charmId: string | null; // 有給護符抽取時的 UserCharm.id
  newBalance: string;
}
