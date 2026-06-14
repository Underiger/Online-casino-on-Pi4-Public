import { z } from 'zod';
import { CHAT_MAX_LENGTH } from '../constants';

// ── Requests ─────────────────────────────────────────────────────────────────

export const ChatSendReqSchema = z.object({
  content: z.string().min(1).max(CHAT_MAX_LENGTH),
});
export type ChatSendReq = z.infer<typeof ChatSendReqSchema>;

// ── Response types ────────────────────────────────────────────────────────────

export interface ChatMessageItem {
  id: string;
  userId: string | null;     // null 表示系統訊息
  username: string | null;
  avatarId: number | null;
  content: string;           // 已過濾 URL、已 HTML entity 轉義
  system: boolean;
  createdAt: string;
}

export interface ChatHistoryRes {
  messages: ChatMessageItem[];
}
