/**
 * 孤兒回合清理 BullMQ job（射龍門/High-Low/Blackjack 新遊戲共用 round-lock 基礎設施
 * 的延伸；參見 high-low.service.ts / blackjack.service.ts 檔頭的孤兒回合說明）。
 *
 * 偵測「不活躍」的方式：每次玩家動作都會 `SET key value EX <ROUND_TTL>` 重設 TTL，
 * 所以一個回合的 Redis key 剩餘 TTL 若低於 `ROUND_TTL - INACTIVITY_THRESHOLD`，
 * 就代表已經至少 INACTIVITY_THRESHOLD 秒沒有任何動作——不需要額外的時間戳記欄位，
 * 純粹用 TTL 倒推即可，這也是不替 BetRecord 加 updatedAt 欄位的原因。
 *
 * 射龍門不需要本 job：它的 open() 不動錢、bet() 是單步原子操作，沒有「卡在半路」
 * 的可能狀態（見 dragon-gate.service.ts 檔頭）。
 *
 * 結算規則交給各遊戲自己的 service（resolveAbandoned）：本檔只負責「掃描出哪些
 * userId 該處理」，完全不知道 GUESSING/RESULT/PLAYER_TURN 是什麼，遊戲規則異動
 * 不需要改這個檔案。
 *
 * 極端 fallback（Redis 重啟把狀態整個沖掉，掃描掃不到任何 key）：這種情況下
 * resolveAbandoned 會發現 Redis 狀態已經不存在（state===null）直接回 resolved:false，
 * 不會去動 Postgres 裡那筆早已存在但找不到 Redis 狀態的 OPEN BetRecord——這類紀錄
 * 只能留待人工對帳（與 slot Jackpot 派彩失敗時的「人工對帳」哲學一致），因為連
 * 「玩家當時卡在哪個狀態」這個結算依據都已經遺失，沒有任何安全的自動結算方式。
 */
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { createJobConnection } from './queues.js';
import {
  HIGH_LOW_ROUND_KEY_PREFIX,
  HIGH_LOW_ROUND_TTL_SECONDS,
  createHighLowService,
  type HighLowService,
} from '../modules/high-low/high-low.service.js';
import {
  BLACKJACK_ROUND_KEY_PREFIX,
  BLACKJACK_ROUND_TTL_SECONDS,
  createBlackjackService,
  type BlackjackService,
} from '../modules/blackjack/blackjack.service.js';
import { createWalletService } from '../modules/wallet/wallet.service.js';

export const ABANDONED_ROUND_QUEUE_NAME = 'abandoned-round-cleanup';
export const ABANDONED_ROUND_JOB = 'scan';

/** 掃描週期：2 分鐘（介於下面的不活躍門檻與 round TTL 之間，確保能及時處理） */
export const ABANDONED_ROUND_SCAN_INTERVAL_MS = 2 * 60 * 1_000;
/** 不活躍門檻：5 分鐘無動作視為孤兒回合 */
export const ABANDONED_ROUND_INACTIVITY_SECONDS = 5 * 60;

/**
 * SCAN `${prefix}*`（不用 KEYS——生產環境鍵多時會阻塞），過濾掉 `:lock` 鎖鍵，
 * 用剩餘 TTL 倒推「距離上次動作是否已超過 inactivityThresholdSeconds」。
 * 回傳值已轉換成 userId（去掉 prefix），供呼叫端直接傳給對應 service.resolveAbandoned。
 */
export async function findStaleRoundUserIds(
  redis: Redis,
  prefix: string,
  roundTtlSeconds: number,
  inactivityThresholdSeconds: number,
): Promise<string[]> {
  const staleBelow = roundTtlSeconds - inactivityThresholdSeconds;
  const userIds: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      if (key.endsWith(':lock')) continue;
      const ttl = await redis.ttl(key);
      // ttl < 0：key 在 SCAN 之後、TTL 查詢之前就被刪除或本來就無過期時間，跳過
      // （正常流程一律 SET ... EX，不會出現無過期時間的 round key）
      if (ttl >= 0 && ttl < staleBelow) {
        userIds.push(key.slice(prefix.length));
      }
    }
  } while (cursor !== '0');
  return userIds;
}

export interface AbandonedRoundJobDeps {
  redis: Redis;
  highLow: Pick<HighLowService, 'resolveAbandoned'>;
  blackjack: Pick<BlackjackService, 'resolveAbandoned'>;
  log?: { warn: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };
}

/** processor 工廠（與 BullMQ 接線分離——單元測試以 fake deps 直接驅動） */
export function createAbandonedRoundProcessor(deps: AbandonedRoundJobDeps) {
  const log = deps.log ?? { warn: () => {} };

  return async (): Promise<void> => {
    try {
      const [staleHighLow, staleBlackjack] = await Promise.all([
        findStaleRoundUserIds(
          deps.redis,
          HIGH_LOW_ROUND_KEY_PREFIX,
          HIGH_LOW_ROUND_TTL_SECONDS,
          ABANDONED_ROUND_INACTIVITY_SECONDS,
        ),
        findStaleRoundUserIds(
          deps.redis,
          BLACKJACK_ROUND_KEY_PREFIX,
          BLACKJACK_ROUND_TTL_SECONDS,
          ABANDONED_ROUND_INACTIVITY_SECONDS,
        ),
      ]);

      let resolvedCount = 0;
      for (const userId of staleHighLow) {
        try {
          const result = await deps.highLow.resolveAbandoned(userId);
          if (result.resolved) resolvedCount += 1;
        } catch (err) {
          log.warn({ err: (err as Error).message, userId }, 'abandoned-round: high-low 結算失敗');
        }
      }
      for (const userId of staleBlackjack) {
        try {
          const result = await deps.blackjack.resolveAbandoned(userId);
          if (result.resolved) resolvedCount += 1;
        } catch (err) {
          log.warn({ err: (err as Error).message, userId }, 'abandoned-round: blackjack 結算失敗');
        }
      }
      log.info?.(
        { scanned: staleHighLow.length + staleBlackjack.length, resolved: resolvedCount },
        'abandoned-round: 掃描完成',
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'abandoned-round: 任務執行失敗（下次迭代自動重試）');
    }
  };
}

/** 啟動時呼叫（server.ts 在 buildApp 之後）：建立 Queue + Worker + 註冊 repeatable */
export async function registerAbandonedRoundJob(app: FastifyInstance): Promise<void> {
  const wallet = createWalletService(app.prisma);
  const highLow = createHighLowService({ prisma: app.prisma, redis: app.redis, wallet, log: app.log });
  const blackjack = createBlackjackService({ prisma: app.prisma, redis: app.redis, wallet, log: app.log });

  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();
  queueConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'abandoned-round: queue redis error'),
  );
  workerConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'abandoned-round: worker redis error'),
  );

  const queue = new Queue(ABANDONED_ROUND_QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: { removeOnComplete: true, removeOnFail: 50 },
  });

  void queue
    .add(ABANDONED_ROUND_JOB, {}, { repeat: { every: ABANDONED_ROUND_SCAN_INTERVAL_MS } })
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'abandoned-round: repeatable 註冊失敗');
    });

  const processor = createAbandonedRoundProcessor({ redis: app.redis, highLow, blackjack, log: app.log });

  const worker = new Worker(ABANDONED_ROUND_QUEUE_NAME, processor, { connection: workerConnection });
  worker.on('failed', (job, err) => {
    app.log.warn({ jobId: job?.id, err: err.message }, 'abandoned-round: worker 任務失敗');
  });

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  });

  app.log.info('abandoned-round: 孤兒回合清理 worker 已註冊');
}
