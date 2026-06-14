/**
 * M08 Socket.IO 基座整合測試：真實 Fastify + Socket.IO 伺服器（port 0 隨機埠）
 * 搭配 socket.io-client 實連。
 *
 * 環境假設：與其他測試一致——無 PG / Redis 也能跑
 * （redis 降級記憶體 adapter、連線計數退化本地、IllegalPacketLog 落庫失敗僅進日誌）。
 * 涵蓋：握手成功（auth.token / query.token）、socket.data 綁定、HTTP API 不受影響、
 * 認證失敗、連線上限拒絕（server_full）、遊戲事件 HMAC 中介層攔截。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// 真實網路 I/O（隨機埠 + websocket 實連），逾時放寬至 10s
const TEST_TIMEOUT_MS = 10_000;
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { initSocketServer } from '../../src/sockets/index.js';
import type { GameServer } from '../../src/sockets/events.js';

// ─────────────────────────── 測試工具 ───────────────────────────

interface TestServer {
  app: FastifyInstance;
  io: GameServer;
  url: string;
}

async function createTestServer(maxConnections: number): Promise<TestServer> {
  const app = await buildApp();
  const io = initSocketServer(app, {
    maxConnections,
    // 隨機鍵前綴：本機若真的有 Redis 在跑，各 suite / 其他進程互不污染計數
    connKeyPrefix: `test:conns:${randomUUID()}`,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  return { app, io, url: `http://127.0.0.1:${address.port}` };
}

function signToken(app: FastifyInstance, sub: string): string {
  return app.jwt.sign({ sub, role: 'PLAYER' });
}

function connectClient(
  url: string,
  opts: { token?: string; query?: Record<string, string> } = {},
): ClientSocket {
  return ioc(url, {
    path: '/socket.io/',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true, // 不重用 client 端 Manager 快取（避免撿到前一測試已關閉的連線）
    timeout: 3_000,
    ...(opts.token !== undefined ? { auth: { token: opts.token } } : {}),
    ...(opts.query !== undefined ? { query: opts.query } : {}),
  });
}

function waitForConnect(socket: ClientSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', (err) => reject(err));
  });
}

function waitForConnectError(socket: ClientSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    socket.once('connect_error', (err) => resolve(err));
    socket.once('connect', () => reject(new Error('預期握手被拒，卻連線成功')));
  });
}

/** emit 帶 ack，回傳 ack 第一參數（錯誤碼或 null） */
function emitWithAck(
  socket: ClientSocket,
  event: string,
  payload: unknown,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack 逾時：${event}`)), 3_000);
    socket.emit(event, payload, (code: string | null) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function disconnectAll(...sockets: ClientSocket[]): void {
  for (const socket of sockets) socket.disconnect();
}

// ═════════════════ 連線與握手 ═════════════════

describe('socket: 連線與握手', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer(200);
    // 測試用 echo handler：驗證封包能進 handler、socket.data 綁定正確
    server.io.on('connection', (socket) => {
      socket.on('echo:ping', (ack: (err: null, data: { userId: string }) => void) => {
        ack(null, { userId: socket.data.userId });
      });
    });
  });

  afterAll(async () => {
    await server.app.close();
  });

  it('有效 JWT（auth.token）握手成功，socket.data.userId 綁定正確', async () => {
    const client = connectClient(server.url, {
      token: signToken(server.app, 'user-aaa'),
    });
    try {
      await waitForConnect(client);
      expect(client.connected).toBe(true);

      // 非簽章事件不受 HMAC 中介層攔截，且 server 端拿得到握手綁定的 userId
      const result = await new Promise<{ userId: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('echo ack 逾時')), 3_000);
        client.emit('echo:ping', (_err: null, data: { userId: string }) => {
          clearTimeout(timer);
          resolve(data);
        });
      });
      expect(result.userId).toBe('user-aaa');
    } finally {
      disconnectAll(client);
    }
  });

  it('JWT 也可由 handshake query 帶入', async () => {
    const client = connectClient(server.url, {
      query: { token: signToken(server.app, 'user-bbb') },
    });
    try {
      await waitForConnect(client);
      expect(client.connected).toBe(true);
    } finally {
      disconnectAll(client);
    }
  });

  it('Socket.IO 附加後既有 HTTP API 不受影響（/healthz 200）', async () => {
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('缺少 token：握手拒絕 UNAUTHORIZED', async () => {
    const client = connectClient(server.url);
    try {
      const err = await waitForConnectError(client);
      expect((err as Error & { data?: { code: string } }).data?.code).toBe('UNAUTHORIZED');
    } finally {
      disconnectAll(client);
    }
  });

  it('偽造 token：握手拒絕 UNAUTHORIZED', async () => {
    const client = connectClient(server.url, { token: 'not-a-jwt' });
    try {
      const err = await waitForConnectError(client);
      expect((err as Error & { data?: { code: string } }).data?.code).toBe('UNAUTHORIZED');
    } finally {
      disconnectAll(client);
    }
  });
});

// ═════════════════ 連線上限 ═════════════════

describe('socket: 連線上限', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer(2); // 上限縮為 2，便於觸發
  });

  afterAll(async () => {
    await server.app.close();
  });

  it('達到上限後新握手被拒（server_full），既有連線不受影響', async () => {
    const token = signToken(server.app, 'user-limit');
    // 逐一連線：client 建構即開始握手，並發建立會讓三者都看到計數 0
    const c1 = connectClient(server.url, { token });
    await waitForConnect(c1);
    const c2 = connectClient(server.url, { token });
    await waitForConnect(c2);
    const c3 = connectClient(server.url, { token });
    try {
      const err = await waitForConnectError(c3);
      expect(err.message).toBe('server_full');
      expect((err as Error & { data?: { code: string } }).data?.code).toBe('SERVER_FULL');

      // 既有連線仍存活
      expect(c1.connected).toBe(true);
      expect(c2.connected).toBe(true);
    } finally {
      disconnectAll(c1, c2, c3);
    }
  }, TEST_TIMEOUT_MS);

  it('連線釋出後可再次握手', async () => {
    const token = signToken(server.app, 'user-release');
    const c1 = connectClient(server.url, { token });
    await waitForConnect(c1);
    c1.disconnect();
    // 等 server 端確實移除連線（disconnect 為非同步傳播）
    await new Promise((resolve) => setTimeout(resolve, 100));

    const c2 = connectClient(server.url, { token });
    try {
      await waitForConnect(c2);
      expect(c2.connected).toBe(true);
    } finally {
      disconnectAll(c2);
    }
  }, TEST_TIMEOUT_MS);
});

// ═════════════════ 遊戲事件 HMAC 中介層 ═════════════════

describe('socket: 遊戲事件 HMAC 中介層', () => {
  let server: TestServer;
  let client: ClientSocket;

  beforeAll(async () => {
    server = await createTestServer(200);
    client = connectClient(server.url, { token: signToken(server.app, 'user-hmac') });
    await waitForConnect(client);
  });

  afterAll(async () => {
    client.disconnect();
    await server.app.close();
  });

  it('slot:spin 缺少簽章欄位 → ack ERR_BAD_SIGNATURE，封包不進 handler', async () => {
    const code = await emitWithAck(client, 'slot:spin', { betAmount: 10 });
    expect(code).toBe('ERR_BAD_SIGNATURE');
  });

  it('slot:spin 時間戳超出 ±5s 容忍窗 → ack ERR_STALE_REQUEST', async () => {
    const code = await emitWithAck(client, 'slot:spin', {
      betAmount: 10,
      sig: 'deadbeef',
      nonce: randomUUID(),
      ts: Date.now() - 60_000, // 過期一分鐘
      seq: 1,
    });
    expect(code).toBe('ERR_STALE_REQUEST');
  });

  it('roulette:bet 注額欄位無法重組 canonical → ack ERR_BAD_SIGNATURE', async () => {
    const code = await emitWithAck(client, 'roulette:bet', {
      roundId: 'r1',
      bets: [{ type: 'RED', amount: -5 }], // 非法注額
      sig: 'deadbeef',
      nonce: randomUUID(),
      ts: Date.now(),
      seq: 2,
    });
    expect(code).toBe('ERR_BAD_SIGNATURE');
  });

  it('payload 非物件 → ack ERR_BAD_SIGNATURE', async () => {
    const code = await emitWithAck(client, 'slot:spin', 'garbage');
    expect(code).toBe('ERR_BAD_SIGNATURE');
  });
});
