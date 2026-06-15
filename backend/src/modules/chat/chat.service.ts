/**
 * Chat 服務（01_GDD §5.3、02_TDD §5.8、05_MILESTONES M17）。
 *
 * 職責：
 *   1. 訊息清理：URL 過濾 → HTML entity 轉義
 *   2. 使用者狀態驗證：已封禁（user.banned）/ 已禁言（user.muted）
 *   3. 頻率限制：1 則/2 秒（burst 桶）+ 10 則/60 秒（分鐘桶），
 *      直接重用 plugins/rate-limit.ts 導出的 TOKEN_BUCKET_LUA
 *   4. 落庫：ChatMessage（PG 保留 7 天，排程清理留 M26）
 *   5. Redis List 緩存：`chat:history`，lpush + ltrim(0,199) + EX 7 天
 *      ── 新連線推送時從 Redis 讀取，減少 DB 查詢；Redis miss 時從 DB 補讀重建
 *   6. 系統訊息發送（jackpot 觸發等，userId = null）
 *
 * Redis 失敗語義：
 *   - 頻率桶不可用 → fail-open（記警告，放行）
 *   - history 寫回失敗 → 記警告，不影響廣播主流程
 */
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { TOKEN_BUCKET_LUA } from '../../plugins/rate-limit.js';

// ─────────────────────────── 常數 ───────────────────────────

/** Redis 歷史訊息 List 鍵 */
export const CHAT_HISTORY_KEY = 'chat:history';
/** 快取保留條數（與 shared CHAT_HISTORY_SIZE 一致） */
export const CHAT_HISTORY_SIZE = 200;
/** 快取 TTL（秒），7 天 */
export const CHAT_HISTORY_TTL_SECONDS = 7 * 24 * 60 * 60;
/** 訊息最大長度（與 shared CHAT_MAX_LENGTH 一致） */
export const CHAT_MAX_LENGTH = 200;

/** 點對點桶：capacity=1, rate=0.5（即最多 1 則/2s） */
const BURST_CAPACITY = 1;
const BURST_RATE = 0.5;
/** 分鐘桶：capacity=10, rate=10/60（最多 10 則/min） */
const MINUTE_CAPACITY = 10;
const MINUTE_RATE = 10 / 60;

/** 洗頻自動禁言：分鐘桶於視窗內連續被擋達此次數即自動禁言（限時，到期自動解除） */
const AUTO_MUTE_THRESHOLD = 5;
/** 洗頻計數視窗（秒）：期間累計達閾值才觸發；之後自然過期重置 */
const AUTO_MUTE_WINDOW_SECONDS = 60;

// ─────────────────────────── 型別（鏡像 packages/shared chat.dto.ts / socket-events.ts）───────────────────────────

/** chat:message 廣播 payload（同 ChatMessagePayload in packages/shared/src/socket-events.ts） */
export interface ChatMessagePayload {
  id: string;
  userId: string | null;
  username: string | null;
  avatarId: number | null;
  content: string;
  system: boolean;
  createdAt: string; // ISO 8601
}

export type ChatRateLimitResult = 'ok' | 'burst_exceeded' | 'minute_exceeded';

export interface ChatLog {
  warn: (obj: unknown, msg?: string) => void;
}

export interface ChatServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  log?: ChatLog;
  /**
   * 洗頻達閾值時自動禁言（缺省則停用自動禁言）。
   * 由 chat.gateway 接 admin.service.setMute（行為者 SYSTEM、限時數分鐘，
   * 到期由 moderation job 自動解除）。
   */
  autoMute?: (userId: string) => Promise<void>;
}

// ─────────────────────────── URL 過濾 + HTML 轉義（純函式，測試直接覆蓋）───────────────────────────

/**
 * 過濾 URL：匹配 https?:// 開頭或裸域名（至少含一點 + TLD ≥2 字元）。
 * 替換為 `[連結已移除]`（GDD §5.3 安全需求）。
 */
const URL_REGEX = /https?:\/\/\S+|(?<![a-z0-9-])([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?(?![a-z0-9-])/gi;

export function filterUrls(text: string): string {
  return text.replace(URL_REGEX, '[連結已移除]');
}

/** HTML entity 轉義（防 XSS；前端 v-text 為第二道，這裡是後端強制轉義） */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 清理管線：URL 過濾 → HTML 轉義 */
export function sanitize(text: string): string {
  return escapeHtml(filterUrls(text.trim()));
}

// ─────────────────────────── service factory ───────────────────────────

export function createChatService(deps: ChatServiceDeps) {
  const { prisma, redis } = deps;
  const log: ChatLog = deps.log ?? { warn: () => {} };
  const autoMute = deps.autoMute;

  // ── 洗頻自動禁言（分鐘桶連續被擋達閾值）──

  const floodKey = (userId: string): string => `chat:flood:${userId}`;

  /**
   * 分鐘桶被擋一次即累計；視窗內達閾值 → 自動禁言（限時，到期由 moderation job 解除）。
   * Redis 故障 → 跳過（fail-open，與頻率桶一致）。一旦禁言，後續訊息於 checkUserStatus
   * 即短路為 USER_MUTED，不會重複觸發。
   */
  async function maybeAutoMute(userId: string): Promise<void> {
    if (autoMute === undefined) return;
    let count: number;
    try {
      count = await redis.incr(floodKey(userId));
      if (count === 1) await redis.expire(floodKey(userId), AUTO_MUTE_WINDOW_SECONDS);
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'chat: 洗頻計數 Redis 不可用，跳過自動禁言');
      return;
    }
    if (count < AUTO_MUTE_THRESHOLD) return;
    try {
      await autoMute(userId);
      await redis.del(floodKey(userId));
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'chat: 自動禁言失敗');
    }
  }

  // ── 令牌桶（與 HTTP rate-limit plugin 同義；直接調 Redis Lua）──

  async function consumeBucket(key: string, capacity: number, rate: number): Promise<boolean> {
    try {
      const result = (await redis.eval(
        TOKEN_BUCKET_LUA,
        1,
        key,
        String(capacity),
        String(rate),
        String(Date.now()),
        '1',
      )) as [number, number];
      return result[0] === 1;
    } catch (err) {
      log.warn({ err: (err as Error).message, key }, 'chat: 頻率桶 Redis 不可用，fail-open 放行');
      return true;
    }
  }

  async function checkRateLimit(userId: string): Promise<ChatRateLimitResult> {
    const burstKey = `chat:rl:burst:${userId}`;
    const minuteKey = `chat:rl:min:${userId}`;

    const burstOk = await consumeBucket(burstKey, BURST_CAPACITY, BURST_RATE);
    if (!burstOk) return 'burst_exceeded';

    const minuteOk = await consumeBucket(minuteKey, MINUTE_CAPACITY, MINUTE_RATE);
    if (!minuteOk) return 'minute_exceeded';

    return 'ok';
  }

  // ── 使用者封禁 / 禁言狀態 ──

  async function checkUserStatus(userId: string): Promise<'ok' | 'banned' | 'muted'> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { banned: true, muted: true },
    });
    if (user === null) return 'banned';
    if (user.banned) return 'banned';
    if (user.muted) return 'muted';
    return 'ok';
  }

  // ── Redis history List 維護 ──

  async function pushToHistory(payload: ChatMessagePayload): Promise<void> {
    const serialized = JSON.stringify(payload);
    try {
      await redis.lpush(CHAT_HISTORY_KEY, serialized);
      await redis.ltrim(CHAT_HISTORY_KEY, 0, CHAT_HISTORY_SIZE - 1);
      await redis.expire(CHAT_HISTORY_KEY, CHAT_HISTORY_TTL_SECONDS);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'chat: history 快取寫回失敗');
    }
  }

  // ── 讀取歷史（新連線時推送）──

  async function getHistory(): Promise<ChatMessagePayload[]> {
    let raws: string[] = [];
    try {
      // lrange 0 N-1 回傳 head→tail（最新→最舊），需 reverse 後送給前端
      raws = await redis.lrange(CHAT_HISTORY_KEY, 0, CHAT_HISTORY_SIZE - 1);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'chat: 讀取 Redis history 失敗，fallback DB');
    }

    if (raws.length > 0) {
      const messages: ChatMessagePayload[] = [];
      for (const raw of raws.reverse()) {
        try {
          messages.push(JSON.parse(raw) as ChatMessagePayload);
        } catch {
          // 損毀條目跳過
        }
      }
      return messages;
    }

    // Redis miss：從 DB 讀最近 CHAT_HISTORY_SIZE 條（舊→新）
    const rows = await prisma.chatMessage.findMany({
      take: CHAT_HISTORY_SIZE,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { username: true, avatarId: true } } },
    });

    const messages: ChatMessagePayload[] = rows.reverse().map((row) => ({
      id: row.id,
      userId: row.userId,
      username: row.user?.username ?? null,
      avatarId: row.user?.avatarId ?? null,
      content: row.content,
      system: row.system,
      createdAt: row.createdAt.toISOString(),
    }));

    // 非同步重建快取（fire-and-forget）
    void (async () => {
      try {
        if (messages.length === 0) return;
        for (const msg of [...messages].reverse()) {
          await redis.lpush(CHAT_HISTORY_KEY, JSON.stringify(msg));
        }
        await redis.ltrim(CHAT_HISTORY_KEY, 0, CHAT_HISTORY_SIZE - 1);
        await redis.expire(CHAT_HISTORY_KEY, CHAT_HISTORY_TTL_SECONDS);
      } catch {
        // 快取重建失敗不影響結果
      }
    })();

    return messages;
  }

  // ── 玩家訊息主流程 ──

  /**
   * 驗證、清理、落庫玩家訊息。
   * 成功：回傳 { payload }；失敗：回傳 { reason } 供 gateway 回傳 ack 錯誤碼。
   */
  async function sendMessage(
    userId: string,
    rawContent: string,
  ): Promise<{ payload: ChatMessagePayload } | { reason: string }> {
    const trimmed = rawContent.trim();
    if (trimmed.length === 0) return { reason: 'EMPTY_MESSAGE' };
    if (trimmed.length > CHAT_MAX_LENGTH) return { reason: 'MESSAGE_TOO_LONG' };

    const status = await checkUserStatus(userId);
    if (status === 'banned') return { reason: 'USER_BANNED' };
    if (status === 'muted') return { reason: 'USER_MUTED' };

    const rateResult = await checkRateLimit(userId);
    if (rateResult === 'burst_exceeded') return { reason: 'RATE_LIMIT_BURST' };
    if (rateResult === 'minute_exceeded') {
      await maybeAutoMute(userId);
      return { reason: 'RATE_LIMIT_MINUTE' };
    }

    const content = sanitize(trimmed);

    const row = await prisma.chatMessage.create({
      data: { userId, content, system: false },
      include: { user: { select: { username: true, avatarId: true } } },
    });

    const payload: ChatMessagePayload = {
      id: row.id,
      userId: row.userId,
      username: row.user?.username ?? null,
      avatarId: row.user?.avatarId ?? null,
      content: row.content,
      system: false,
      createdAt: row.createdAt.toISOString(),
    };

    await pushToHistory(payload);
    return { payload };
  }

  // ── 系統訊息（Jackpot 觸發、公告等）──

  async function sendSystemMessage(content: string): Promise<ChatMessagePayload> {
    const row = await prisma.chatMessage.create({
      data: { userId: null, content, system: true },
    });
    const payload: ChatMessagePayload = {
      id: row.id,
      userId: null,
      username: null,
      avatarId: null,
      content: row.content,
      system: true,
      createdAt: row.createdAt.toISOString(),
    };
    await pushToHistory(payload);
    return payload;
  }

  return { sendMessage, sendSystemMessage, getHistory, sanitize, checkRateLimit };
}

export type ChatService = ReturnType<typeof createChatService>;
