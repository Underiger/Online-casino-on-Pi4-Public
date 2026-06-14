/**
 * Roulette Socket.IO Gateway（M15；事件凍結於 docs/04_API_SPEC.md §4）。
 *
 * 安裝點：sockets/index.ts 的 io.on('connection') 內呼叫 install(socket)。
 *
 * 處理事件（Client → Server）：
 *   - roulette:bet：已先通過 M06/M08 createGameEventGuard（HMAC 簽章事件白名單，
 *     canonical betAmount = bets[].amount 加總）→ service.placeBets
 *     → 個人 roulette:bet_ack（成功與失敗都發；錯誤碼另經 ack callback 回傳）
 *   - roulette:cancel：不需簽章（退款路徑，與 chat:send 同等級）→ service.cancelBets
 *     → ack callback 回 { cancelled, refunded } 或錯誤碼
 *
 * 廣播（Server → Client，由 service hooks 觸發、僅 leader worker 發出）：
 *   - roulette:phase / roulette:bets_snapshot：io.emit 全服（redis adapter 跨 worker）
 *   - roulette:result：全服共通 payload + 個人損益——參與者各自的 user room
 *     收個人化 payload（personalPayout / newBalance），其餘連線以 io.except 收
 *     personalPayout: null 版本；user room 於連線安裝時 join（跨 worker 由
 *     redis adapter 路由，結算 worker 不必持有該玩家的 socket）。
 *
 * 連線後狀態同步：install 時對該 socket 推送一次 roulette:phase（讀回合快照），
 * 中途加入的客戶端不必等下一次階段轉換（最長 15s）即可渲染當前狀態。
 */
import type { FastifyInstance } from 'fastify';
import { SOCKET_EVENTS, type GameServer, type GameSocket } from '../../sockets/events.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createChatService } from '../chat/chat.service.js';
import { createDailyService, type DailyService } from '../daily/daily.service.js';
import { createAchievementService, type AchievementService } from '../achievement/achievement.service.js';
import {
  createRouletteService,
  type RouletteBroadcastHooks,
  type RouletteService,
} from './roulette.service.js';
import type {
  RoulettePersonalResult,
  RouletteResultCommon,
  RouletteResultPayload,
} from './roulette.types.js';

/** 個人化廣播用 room（roulette:result 個人損益；未來個人事件可複用） */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** service hooks → Socket.IO 廣播（leader worker 專用出口） */
export function createRouletteBroadcastHooks(io: GameServer, daily?: DailyService, achievement?: AchievementService): RouletteBroadcastHooks {
  return {
    onPhase(payload) {
      io.emit(SOCKET_EVENTS.ROULETTE_PHASE, payload);
    },

    onSnapshot(payload) {
      io.emit(SOCKET_EVENTS.ROULETTE_BETS_SNAPSHOT, payload);
    },

    onResult(
      common: RouletteResultCommon,
      perUser: ReadonlyMap<string, RoulettePersonalResult>,
    ) {
      // 參與者：個人化 payload（各自 user room；跨 worker 由 redis adapter 路由）
      const participantRooms: string[] = [];
      for (const [userId, result] of perUser) {
        const room = userRoom(userId);
        participantRooms.push(room);
        const personal: RouletteResultPayload = {
          ...common,
          personalPayout: result.payout,
          newBalance: result.newBalance.toString(),
        };
        io.to(room).emit(SOCKET_EVENTS.ROULETTE_RESULT, personal);
      }
      // 其餘全服：personalPayout null（docs/04_API_SPEC.md §4.3：null = 本回合未下注）
      const spectator: RouletteResultPayload = {
        ...common,
        personalPayout: null,
        newBalance: null,
      };
      if (participantRooms.length > 0) {
        io.except(participantRooms).emit(SOCKET_EVENTS.ROULETTE_RESULT, spectator);
      } else {
        io.emit(SOCKET_EVENTS.ROULETTE_RESULT, spectator);
      }

      // M18：每位參與者計 1 次 ROULETTE_ROUNDS 任務進度
      if (daily !== undefined) {
        for (const [uid] of perUser) {
          void daily.updateProgress(uid, 'ROULETTE_ROUNDS', 1, io).catch(() => {});
        }
      }
      // M20：ROULETTE_100 成就里程碑
      if (achievement !== undefined) {
        const achIo = { to: (room: string) => ({ emit: (ev: string, d: unknown): void => void io.to(room).emit(ev, d) }) };
        for (const [uid] of perUser) {
          void achievement.checkRouletteMilestone(uid, achIo).catch(() => {});
        }
      }
    },
  };
}

export interface RouletteGatewayOptions {
  /** 測試注入：覆寫整個 service（注入時由呼叫方掌控 start/stop 生命週期） */
  service?: RouletteService;
}

export interface RouletteGatewayInit {
  service: RouletteService;
  /** 為單一 socket 安裝 roulette 事件監聽器（io.on('connection') 內呼叫） */
  install: (socket: GameSocket) => void;
  /** service 是否由本函式建立（true 時呼叫方應代為 start/stop） */
  owned: boolean;
}

export function initRouletteGateway(
  app: FastifyInstance,
  io: GameServer,
  opts: RouletteGatewayOptions = {},
): RouletteGatewayInit {
  const owned = opts.service === undefined;
  const wallet = createWalletService(app.prisma);
  const daily = createDailyService({ prisma: app.prisma, redis: app.redis, wallet, log: app.log });
  const achievement = createAchievementService({ prisma: app.prisma, wallet, log: app.log });
  const service =
    opts.service ??
    createRouletteService({
      prisma: app.prisma,
      redis: app.redis,
      wallet,
      hooks: createRouletteBroadcastHooks(io, daily, achievement),
      chat: createChatService({ prisma: app.prisma, redis: app.redis, log: app.log }),
      log: app.log,
    });

  function install(socket: GameSocket): void {
    const { userId } = socket.data;

    // roulette:result 個人損益的路由前提：每條連線加入自己的 user room
    void socket.join(userRoom(userId));

    // ── 連線後狀態同步：推送當前回合 phase（不等下一次轉換） ──
    service
      .getRoundSnapshot()
      .then((snapshot) => {
        if (snapshot === null) return;
        socket.emit(SOCKET_EVENTS.ROULETTE_PHASE, {
          roundId: snapshot.roundId,
          phase: snapshot.phase,
          phaseEndsAt: new Date(snapshot.phaseEndsAt).toISOString(),
          participantCount: 0, // 即時計數由下一次全服 phase 廣播校正
        });
      })
      .catch((err: unknown) => {
        app.log.warn({ err, socketId: socket.id }, 'roulette: 連線狀態同步失敗');
      });

    // ── roulette:bet（HMAC 中介層已驗畢才會進到這裡） ──
    socket.on(SOCKET_EVENTS.ROULETTE_BET, (payload: unknown, ack: unknown) => {
      const ackFn = typeof ack === 'function' ? (ack as (err: string | null) => void) : null;
      service
        .placeBets(userId, payload)
        .then((result) => {
          if (result.ok) {
            socket.emit(SOCKET_EVENTS.ROULETTE_BET_ACK, result.ack);
            ackFn?.(null);
            return;
          }
          // 失敗：bet_ack（accepted=false，附當前額度）+ ack 錯誤碼
          socket.emit(SOCKET_EVENTS.ROULETTE_BET_ACK, {
            accepted: false,
            roundId:
              typeof payload === 'object' &&
              payload !== null &&
              typeof (payload as Record<string, unknown>)['roundId'] === 'string'
                ? ((payload as Record<string, unknown>)['roundId'] as string)
                : '',
            totalBet: 0,
            remaining: 0,
          });
          ackFn?.(result.code);
        })
        .catch((err: unknown) => {
          app.log.error({ err, userId, socketId: socket.id }, 'roulette: placeBets 未知例外');
          ackFn?.('INTERNAL_ERROR');
        });
    });

    // ── roulette:cancel ──
    socket.on(SOCKET_EVENTS.ROULETTE_CANCEL, (payload: unknown, ack: unknown) => {
      const ackFn =
        typeof ack === 'function'
          ? (ack as (err: string | null, res?: { cancelled: boolean; refunded: number }) => void)
          : null;
      service
        .cancelBets(userId, payload)
        .then((result) => {
          if (result.ok) {
            ackFn?.(null, { cancelled: result.cancelled, refunded: result.refunded });
            return;
          }
          ackFn?.(result.code);
        })
        .catch((err: unknown) => {
          app.log.error({ err, userId, socketId: socket.id }, 'roulette: cancelBets 未知例外');
          ackFn?.('INTERNAL_ERROR');
        });
    });
  }

  return { service, install, owned };
}
