/**
 * Chat Cleanup BullMQ Job（01_GDD §5.3、02_TDD §6.5「聊天清理 04:30」）。
 *
 * 每日 04:30 Asia/Taipei 執行：刪除 DB 內超過 7 天的 ChatMessage。Redis `chat:history`
 * 本身已有獨立的 7 天 TTL 作為展示快取，會自然過期——本 job 負責清理「持久層」
 * 累積的舊訊息，避免 chat_messages 表無限增長（兩者保留窗一致但互不依賴）。
 *
 * 排在凌晨 04:30（而非 00:00）：避開與 daily-reset（00:00）、leaderboard 每日快照
 * 等排程的時間點疊加，符合 02_TDD §6.5 的排程錯峰原則。
 *
 * 處理器工廠（createChatCleanupProcessor）與 BullMQ 接線分離——單元測試以 fake deps
 * 直接驅動，不需要真 Worker。
 *
 * cluster ×2 workers 各自呼叫 registerChatCleanupJob：cron spec 以 repeat key 去重，
 * 每次迭代僅一個 Worker 取得執行權（BullMQ 天然單執行）。
 */
import { Queue, Worker } from 'bullmq';
import type { FastifyInstance } from 'fastify';
import { createJobConnection } from './queues.js';
import { createChatService, type ChatService } from '../modules/chat/chat.service.js';

export const CHAT_CLEANUP_QUEUE_NAME = 'chat-cleanup';
export const CHAT_CLEANUP_JOB = 'cleanup';

export interface ChatCleanupJobDeps {
  chat: Pick<ChatService, 'cleanupOldMessages'>;
  log?: { warn: (obj: unknown, msg?: string) => void; info?: (obj: unknown, msg?: string) => void };
}

/** processor 工廠（單元測試直接呼叫此函式取得 processor，傳入 fake deps） */
export function createChatCleanupProcessor(deps: ChatCleanupJobDeps) {
  return async (): Promise<void> => {
    try {
      const count = await deps.chat.cleanupOldMessages();
      deps.log?.info?.({ count }, 'chat-cleanup: 已清理逾期訊息');
    } catch (err) {
      deps.log?.warn?.(
        { err: (err as Error).message },
        'chat-cleanup: 任務執行失敗（下次迭代自動重試）',
      );
    }
  };
}

/** 啟動時呼叫（server.ts）：建立 Queue + Worker + 註冊 04:30 Asia/Taipei repeatable cron */
export async function registerChatCleanupJob(app: FastifyInstance): Promise<void> {
  const chat = createChatService({ prisma: app.prisma, redis: app.redis, log: app.log });

  const queueConnection = createJobConnection();
  const workerConnection = createJobConnection();

  queueConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'chat-cleanup: queue redis error'),
  );
  workerConnection.on('error', (err) =>
    app.log.debug({ err: err.message }, 'chat-cleanup: worker redis error'),
  );

  const queue = new Queue(CHAT_CLEANUP_QUEUE_NAME, {
    connection: queueConnection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 50,
    },
  });

  void queue
    .add(CHAT_CLEANUP_JOB, {}, { repeat: { pattern: '30 4 * * *', tz: 'Asia/Taipei' } })
    .catch((err: unknown) => {
      app.log.warn({ err: (err as Error).message }, 'chat-cleanup: repeatable 註冊失敗');
    });

  const processor = createChatCleanupProcessor({ chat, log: app.log });

  const worker = new Worker(CHAT_CLEANUP_QUEUE_NAME, processor, {
    connection: workerConnection,
  });

  worker.on('failed', (job, err) => {
    app.log.warn({ jobId: job?.id, err: err.message }, 'chat-cleanup: worker 任務失敗');
  });

  app.addHook('onClose', async () => {
    await worker.close();
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  });

  app.log.info('chat-cleanup: 每日 04:30 Asia/Taipei 清理 job 已註冊');
}
