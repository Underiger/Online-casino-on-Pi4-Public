/**
 * Socket.IO 事件名稱常數與共用型別（04_FOLDER_STRUCTURE §1 sockets/events.ts）。
 *
 * 事件名稱凍結於 docs/04_API_SPEC.md §4 與 packages/shared/src/socket-events.ts。
 * 注意：backend tsconfig 的 rootDir=src 使其暫時無法直接 import packages/shared
 * 的 .ts 入口（NodeNext 下會違反 rootDir）——本檔為其鏡像，欄位以 API_SPEC 為準；
 * 待 shared 改為編譯產物（或 project references）後改為 re-export。
 */
import type { Server, Socket } from 'socket.io';

// ─────────────────────────── 事件名稱常數 ───────────────────────────

export const SOCKET_EVENTS = {
  // Client → Server
  SLOT_SPIN: 'slot:spin',
  ROULETTE_BET: 'roulette:bet',
  ROULETTE_CANCEL: 'roulette:cancel',
  CHAT_SEND: 'chat:send',

  // Server → Client（個人）
  SLOT_RESULT: 'slot:result',
  ROULETTE_BET_ACK: 'roulette:bet_ack',
  CHAT_HISTORY: 'chat:history',
  ACHIEVEMENT_UNLOCKED: 'achievement:unlocked',
  DAILY_TASK_UPDATED: 'daily:task_updated',

  // Server → Client（全服廣播）
  ROULETTE_PHASE: 'roulette:phase',
  ROULETTE_RESULT: 'roulette:result',
  ROULETTE_BETS_SNAPSHOT: 'roulette:bets_snapshot',
  JACKPOT_TICK: 'jackpot:tick',
  JACKPOT_WON: 'jackpot:won',
  CHAT_MESSAGE: 'chat:message',
  SYSTEM_ANNOUNCEMENT: 'system:announcement',

  // 握手階段拒絕（連線數已滿）
  SERVER_FULL: 'server_full',
} as const;

export type SocketEventName = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];

// ─────────────────────────── Socket 型別 ───────────────────────────

/**
 * 握手 JWT 驗證成功後綁定於 socket.data（02_TDD §5.2：
 * 「中介層驗證後綁定 socket.data.userId；其後每個遊戲事件仍需簽章」）。
 */
export interface SocketSessionData {
  userId: string;
  role: 'PLAYER' | 'ADMIN';
}

/**
 * 事件表型別：M08 僅需基座（事件 handler 由 M11/M15/M17 各 gateway 註冊），
 * 故先用寬鬆 map；待 shared 可匯入後換成 ClientToServerEvents / ServerToClientEvents。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LooseEventsMap = Record<string, (...args: any[]) => void>;

export type GameServer = Server<LooseEventsMap, LooseEventsMap, LooseEventsMap, SocketSessionData>;
export type GameSocket = Socket<LooseEventsMap, LooseEventsMap, LooseEventsMap, SocketSessionData>;
