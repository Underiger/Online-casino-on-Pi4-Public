/**
 * Socket.IO 伺服器初始化（02_TDD §2、04_FOLDER_STRUCTURE §1 sockets/index.ts）：
 * 附加至 Fastify 的 HTTP server（每個 cluster worker 各建一個實例）。
 *
 * - path '/socket.io/'（與 Nginx location /socket.io/ 一致）；
 *   transports ['polling','websocket']、maxHttpBufferSize 4KB（02_TDD §8）。
 * - Redis adapter（@socket.io/redis-adapter）：跨 worker 廣播——
 *   pub 用主連線 app.redis（publish 為一般命令）、sub 用 app.redisSub
 *   （redis plugin 為此預留的訂閱專用連線）。開發環境 Redis 未就緒時
 *   降級為記憶體 adapter（單 worker 內廣播仍可用）；生產由 redis plugin
 *   啟動時 fail loud 保證連線存在。
 * - 握手：JWT 驗證 + 全域連線上限（middleware.ts）。
 * - 遊戲事件 HMAC：每條連線安裝 socket.use 封包中介層（middleware.ts）。
 * - 斷線重連：依賴 Socket.IO 原生機制（client 端自動重連、重新握手驗證）。
 * - 關閉：onClose hook 先斷開所有 socket 再 io.close()（hooks 為 LIFO，
 *   先於 redis plugin 的 quit 執行，adapter 取消訂閱時連線仍在）。
 */
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { env } from '../config/env.js';
import {
  createConnectionGauge,
  createGameEventGuard,
  createHandshakeAuth,
} from './middleware.js';
import type { GameServer, GameSocket, SocketSessionData } from './events.js';
import { createChatGateway } from '../modules/chat/chat.gateway.js';
import { initRouletteGateway } from '../modules/roulette/roulette.gateway.js';
import type { RouletteService } from '../modules/roulette/roulette.service.js';


/** maxHttpBufferSize：本專案最大 payload 為 roulette:bet，4KB 綽綽有餘且防濫用 */
export const SOCKET_MAX_HTTP_BUFFER_BYTES = 4 * 1_024;

declare module 'fastify' {
  interface FastifyInstance {
    io: GameServer;
  }
}

export interface InitSocketOptions {
  /** 全域連線上限，預設 env.SOCKET_MAX_CONNECTIONS（200） */
  maxConnections?: number;
  /** 連線計數 Redis 鍵前綴（整合測試傳入隨機前綴互相隔離） */
  connKeyPrefix?: string;
  /**
   * 輪盤模組（M15）：enabled 預設「test 環境關閉、其餘開啟」——
   * 既有 socket 整合測試不會被回合機的計時器干擾；測試可注入 service
   * （注入時生命週期由測試掌控，initSocketServer 不代為 start/stop）。
   */
  roulette?: { enabled?: boolean; service?: RouletteService };
}

/**
 * 建立 Socket.IO 伺服器並附加至 app.server（Fastify 於實例化時即建立
 * HTTP server，attach 早於 listen 亦可；engine.io 會接管 'request'/'upgrade'
 * 監聽器，非 /socket.io/ 路徑的請求原樣轉交 Fastify——HTTP API 不受影響）。
 */
export function initSocketServer(
  app: FastifyInstance,
  opts: InitSocketOptions = {},
): GameServer {
  const maxConnections = opts.maxConnections ?? env.SOCKET_MAX_CONNECTIONS;

  const io: GameServer = new Server(app.server, {
    path: '/socket.io/',
    transports: ['polling', 'websocket'],
    maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_BYTES,
    serveClient: false,
    // 開發環境前端（:5173/:5174）可能跨源直連；生產同源（Nginx 反代）無需 CORS
    ...(env.NODE_ENV === 'development'
      ? { cors: { origin: true, credentials: true } }
      : {}),
  });

  // ── Redis adapter：跨 worker 廣播（02_TDD §2 cluster 模式） ──
  if (app.redis.status === 'ready' && app.redisSub.status === 'ready') {
    io.adapter(createAdapter(app.redis, app.redisSub));
    app.log.info('socket.io: redis adapter 已啟用（跨 worker 廣播）');
  } else if (env.NODE_ENV === 'production') {
    // redis plugin 於生產啟動時已 fail loud，理論上不會走到這裡——雙保險
    throw new Error('socket.io: 生產環境 Redis 未就緒，無法啟用 redis adapter');
  } else {
    app.log.warn(
      'socket.io: Redis 未就緒，降級為記憶體 adapter（僅單 worker 內廣播；' +
        '請 docker compose up -d 後重啟）',
    );
  }

  // ── 連線計數（跨 worker）＋ 握手驗證（JWT + 上限） ──
  const gauge = createConnectionGauge({
    redis: app.redis,
    localCount: () => io.of('/').sockets.size,
    ...(opts.connKeyPrefix !== undefined ? { keyPrefix: opts.connKeyPrefix } : {}),
    log: app.log,
  });
  gauge.start();
  io.use(createHandshakeAuth(app, gauge, maxConnections));

  // ── M15 輪盤：回合狀態機 + gateway（leader 選主於 service.start 內處理） ──
  const rouletteEnabled = opts.roulette?.enabled ?? env.NODE_ENV !== 'test';
  let installRouletteGateway: ((socket: GameSocket) => void) | null = null;
  if (rouletteEnabled) {
    const roulette = initRouletteGateway(app, io, {
      ...(opts.roulette?.service !== undefined ? { service: opts.roulette.service } : {}),
    });
    installRouletteGateway = roulette.install;
    if (roulette.owned) {
      roulette.service.start();
      app.addHook('onClose', async () => {
        await roulette.service.stop();
      });
    }
  }

  // ── 連線生命週期：HMAC 封包中介層 + 計數發布 ──
  const installGameEventGuard = createGameEventGuard(app);
  const installChatGateway = createChatGateway(app, io);
  io.on('connection', (socket) => {
    installGameEventGuard(socket);
    installChatGateway(socket);
    installRouletteGateway?.(socket);
    gauge.publish();

    const { userId } = socket.data as SocketSessionData;
    app.log.info(
      { socketId: socket.id, userId, transport: socket.conn.transport.name },
      'socket: connected',
    );

    socket.on('disconnect', (reason) => {
      gauge.publish();
      app.log.info({ socketId: socket.id, userId, reason }, 'socket: disconnected');
    });
  });

  // ── graceful shutdown：先停心跳、踢所有連線，再關閉 engine 與 adapter ──
  app.decorate('io', io);
  app.addHook('onClose', async () => {
    gauge.stop();
    io.local.disconnectSockets(true);
    await new Promise<void>((resolve) => {
      void io.close(() => resolve());
    });
    app.log.info('socket.io: closed');
  });

  return io;
}
