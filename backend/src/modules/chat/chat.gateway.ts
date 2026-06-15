/**
 * Chat Socket.IO Gateway（M17）。
 *
 * 安裝點：sockets/index.ts 的 io.on('connection') callback 內呼叫 installChatGateway(socket)。
 *
 * 處理事件：
 *   - chat:send（Client → Server）：驗證 → 落庫 → io.emit(chat:message) 全服廣播
 *
 * 新連線推送歷史：
 *   - 連線後立即 socket.emit(chat:history, { messages }) 推送近 200 則
 *
 * chat:send 不需 HMAC（docs/04_API_SPEC.md §4.2 凍結：聊天不屬於下注路徑），
 * 但必須通過 M06 createGameEventGuard 之後（socket.use 中介層，僅攔截簽章事件）——
 * 由於 chat:send 不在 SIGNED_SOCKET_EVENTS 白名單中，中介層會直接放行。
 */
import type { FastifyInstance } from 'fastify';
import { SOCKET_EVENTS } from '../../sockets/events.js';
import type { GameServer, GameSocket } from '../../sockets/events.js';
import { createChatService, type ChatService } from './chat.service.js';
import { createDailyService } from '../daily/daily.service.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createAchievementService } from '../achievement/achievement.service.js';
import { createAdminService } from '../admin/admin.service.js';

/** 洗頻自動禁言時長（分鐘）；到期由 moderation job 自動解除 */
const CHAT_FLOOD_MUTE_MINUTES = 5;
/** 自動禁言的稽核行為者 / 來源 / 理由 */
const CHAT_FLOOD_MUTE_ACTOR = 'SYSTEM';
const CHAT_FLOOD_MUTE_IP = 'system';
const CHAT_FLOOD_MUTE_REASON = 'auto: 聊天洗頻自動禁言';

export interface ChatGatewayOptions {
  /** 測試注入 */
  service?: ChatService;
}

/**
 * 回傳「為單一 socket 安裝 chat 事件監聽器」的安裝器。
 * 呼叫時機：io.on('connection') 內、gameEventGuard 之後。
 */
export function createChatGateway(
  app: FastifyInstance,
  io: GameServer,
  opts: ChatGatewayOptions = {},
) {
  const wallet = createWalletService(app.prisma);
  // 洗頻自動禁言：複用 admin.setMute（限時，到期由 moderation job 自動解除）。
  // scheduleTimedUnmute 惰性引用——moderation job 於 server.ts 較晚註冊，
  // 自動禁言發生於請求時，屆時 decorator 已就緒。
  const moderation = createAdminService({
    prisma: app.prisma,
    redis: app.redis,
    wallet,
    scheduleTimedUnmute: (userId: string, mutedUntil: string, delayMs: number): void => {
      if (app.hasDecorator('scheduleTimedUnmute')) {
        app.scheduleTimedUnmute(userId, mutedUntil, delayMs);
      }
    },
    log: app.log,
  });

  const service =
    opts.service ??
    createChatService({
      prisma: app.prisma,
      redis: app.redis,
      log: app.log,
      autoMute: (userId: string): Promise<void> =>
        moderation
          .setMute(CHAT_FLOOD_MUTE_ACTOR, userId, true, CHAT_FLOOD_MUTE_IP, {
            durationMinutes: CHAT_FLOOD_MUTE_MINUTES,
            reason: CHAT_FLOOD_MUTE_REASON,
          })
          .then(() => undefined),
    });

  const daily = createDailyService({
    prisma: app.prisma,
    redis: app.redis,
    wallet,
    log: app.log,
  });
  const achievement = createAchievementService({ prisma: app.prisma, wallet, log: app.log });

  return function install(socket: GameSocket): void {
    const { userId } = socket.data;

    // ── 連線後推送歷史訊息（個人）──
    service
      .getHistory()
      .then((messages) => {
        socket.emit(SOCKET_EVENTS.CHAT_HISTORY, { messages });
      })
      .catch((err: unknown) => {
        app.log.warn({ err, socketId: socket.id }, 'chat: getHistory 失敗，跳過歷史推送');
      });

    // ── chat:send 事件處理 ──
    socket.on(SOCKET_EVENTS.CHAT_SEND, (payload: unknown, ack: unknown) => {
      const ackFn = typeof ack === 'function' ? (ack as (err: string | null) => void) : null;

      // payload 型別防禦（中介層已放行，但仍需 guard）
      const content =
        typeof payload === 'object' &&
        payload !== null &&
        typeof (payload as Record<string, unknown>)['content'] === 'string'
          ? ((payload as Record<string, unknown>)['content'] as string)
          : '';

      service
        .sendMessage(userId, content)
        .then((result) => {
          if ('reason' in result) {
            ackFn?.(result.reason);
            return;
          }
          // 成功：廣播給全服（含自己）
          io.emit(SOCKET_EVENTS.CHAT_MESSAGE, result.payload);
          ackFn?.(null);
          // M18：任務進度更新（fire-and-forget）
          void daily.updateProgress(userId, 'CHAT_COUNT', 1, io).catch(() => {});
          // M20：CHATTERBOX 成就里程碑
          const achIo = { to: (room: string) => ({ emit: (ev: string, d: unknown): void => void io.to(room).emit(ev, d) }) };
          void achievement.checkChatMilestone(userId, achIo).catch(() => {});
        })
        .catch((err: unknown) => {
          app.log.error({ err, userId, socketId: socket.id }, 'chat: sendMessage 未知例外');
          ackFn?.('INTERNAL_ERROR');
        });
    });
  };
}
