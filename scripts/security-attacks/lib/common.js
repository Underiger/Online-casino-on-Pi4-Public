/**
 * scripts/security-attacks/lib/common.js — M27 安全演練共用工具（CommonJS）。
 *
 * 這些腳本對「執行中的後端」（npm run dev）發動受控攻擊，驗證安全防線是否
 * 回傳預期錯誤碼，並（盡力）檢查 IllegalPacketLog 是否落庫。
 *
 * 前置：
 *   1. 後端執行中：`npm run dev`（或 docker-compose.arm64.yml）。
 *   2. PostgreSQL + Redis 執行中（Redis 在線時 hmac-guard 才會真正驗章；
 *      開發模式下 Redis 離線會 fail-open 跳過驗章，演練將失去意義）。
 *   3. 建議使用獨立測試資料庫，避免污染開發資料。
 *
 * 環境變數：
 *   SECURITY_TARGET_URL  後端 base URL（預設 http://localhost:3000）
 *   DATABASE_URL         （選用）供 IllegalPacketLog 落庫檢查；未設定則略過該檢查
 *
 * 相依：Node 20 內建 fetch / crypto；socket 類攻擊需 socket.io-client（後端
 *      workspace 既有相依，npm install 後已於 root node_modules 提供）。
 */
'use strict';

const crypto = require('node:crypto');

const TARGET_URL = (process.env.SECURITY_TARGET_URL || 'http://localhost:3000').replace(/\/$/, '');
const API = `${TARGET_URL}/api`;

// ─────────────────────────── 終端輸出 ───────────────────────────

const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

const log = {
  section: (t) => console.log(`\n${C.bold}${C.cyan}=== ${t} ===${C.reset}`),
  info: (m) => console.log(`${C.gray}  · ${m}${C.reset}`),
  ok: (m) => console.log(`${C.green}  ✓ ${m}${C.reset}`),
  fail: (m) => console.log(`${C.red}  ✗ ${m}${C.reset}`),
  warn: (m) => console.log(`${C.yellow}  ! ${m}${C.reset}`),
};

// ─────────────────────────── 基礎工具 ───────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

/** HMAC-SHA256(base64url 金鑰, canonical) → hex（與 backend security/hmac.ts 同義） */
function hmacSign(hmacKeyB64url, canonical) {
  return crypto
    .createHmac('sha256', Buffer.from(hmacKeyB64url, 'base64url'))
    .update(canonical)
    .digest('hex');
}

/** slot canonical：${userId}|SLOT|${betAmount}|${nonce}|${ts} */
function slotCanonical(userId, betAmount, nonce, ts) {
  return `${userId}|SLOT|${betAmount}|${nonce}|${ts}`;
}

/** roulette canonical：${userId}|ROULETTE|${totalAmount}|${nonce}|${ts} */
function rouletteCanonical(userId, totalAmount, nonce, ts) {
  return `${userId}|ROULETTE|${totalAmount}|${nonce}|${ts}`;
}

// ─────────────────────────── 後端可用性 ───────────────────────────

async function pingBackend() {
  try {
    const res = await fetch(`${TARGET_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 確認後端在線，否則印出指引並以非零碼結束 */
async function requireBackend() {
  if (await pingBackend()) return;
  log.fail(`後端無法連線：${TARGET_URL}`);
  log.info('請先啟動後端：npm run dev（並確認 PostgreSQL + Redis 在線）');
  process.exit(2);
}

// ─────────────────────────── 註冊 / 登入 ───────────────────────────

/** 註冊並登入一個全新玩家，回傳 { userId, accessToken, refreshToken, hmacKey } */
async function registerAndLogin() {
  const username = `atk_${crypto.randomBytes(6).toString('hex')}`.slice(0, 20);
  const password = 'Sec#Drill2026';

  const reg = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (reg.status !== 201) {
    throw new Error(`register 失敗（${reg.status}）：${await reg.text()}`);
  }
  const { userId } = await reg.json();

  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (login.status !== 200) {
    throw new Error(`login 失敗（${login.status}）：${await login.text()}`);
  }
  const body = await login.json();
  if (!body.hmacKey) {
    throw new Error('login 未下發 hmacKey——後端可能在 Redis 離線下以空金鑰續行，演練無法進行');
  }
  return {
    userId,
    username,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    hmacKey: body.hmacKey,
  };
}

// ─────────────────────────── slot:spin 請求 ───────────────────────────

/** 以會話金鑰簽出一個完整 spin 封包（含 sig） */
function signSpin(session, { betAmount, nonce = uuid(), ts = Date.now(), seq }) {
  const sig = hmacSign(session.hmacKey, slotCanonical(session.userId, betAmount, nonce, ts));
  return { betAmount, sig, nonce, ts, seq };
}

/**
 * 送出一個 spin 封包（可覆寫 body 注額以製造竄改）。
 * 回傳 { status, code, body }（code 取自 { error: { code } }）。
 */
async function sendSpin(session, packet, bodyOverride) {
  const res = await fetch(`${API}/slot/spin`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`,
      'x-sig': packet.sig,
      'x-nonce': packet.nonce,
      'x-ts': String(packet.ts),
      'x-seq': String(packet.seq),
    },
    body: JSON.stringify(bodyOverride ?? { betAmount: packet.betAmount }),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 無 body */
  }
  return { status: res.status, code: json?.error?.code ?? null, body: json };
}

// ─────────────────────────── socket.io 連線 ───────────────────────────

/** 連上 socket.io（auth.token = accessToken）；回傳已連線的 client socket */
function connectSocket(session, { timeoutMs = 8000 } = {}) {
  let ioClient;
  try {
    // eslint-disable-next-line global-require
    ioClient = require('socket.io-client');
  } catch {
    throw new Error(
      'socket.io-client 未安裝——請於 repo 根目錄執行 `npm install`（後端 workspace 已宣告此相依）',
    );
  }
  const io = ioClient.io || ioClient.default || ioClient;
  const socket = io(TARGET_URL, {
    path: '/socket.io/',
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    auth: { token: session.accessToken },
    timeout: timeoutMs,
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket 連線逾時')), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      reject(new Error(`socket 連線被拒：${err.message}`));
    });
  });
}

// ─────────────────────────── IllegalPacketLog 落庫檢查（best-effort） ───────────────────────────

let _prisma = null;
let _prismaTried = false;

function getPrisma() {
  if (_prismaTried) return _prisma;
  _prismaTried = true;
  try {
    if (!process.env.DATABASE_URL) {
      // 嘗試載入 repo 根 .env（後端 env.ts 同款行為）
      try {
        process.loadEnvFile();
      } catch {
        /* 無 .env 也無妨 */
      }
    }
    if (!process.env.DATABASE_URL) return null;
    // eslint-disable-next-line global-require
    const { PrismaClient } = require('@prisma/client');
    _prisma = new PrismaClient();
  } catch {
    _prisma = null;
  }
  return _prisma;
}

/**
 * 檢查 IllegalPacketLog 是否在 sinceMs 之後對 userId 落了一筆指定 violation。
 * 回傳 'found' | 'not_found' | 'skipped'（DB 不可用時 skipped）。
 */
async function checkIllegalPacketLog({ userId, violation, sinceMs }) {
  const prisma = getPrisma();
  if (!prisma) return 'skipped';
  try {
    const row = await prisma.illegalPacketLog.findFirst({
      where: {
        userId,
        violation,
        ...(sinceMs ? { createdAt: { gte: new Date(sinceMs) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return row ? 'found' : 'not_found';
  } catch {
    return 'skipped';
  }
}

/** best-effort 讀取 user.muted（聊天洗頻後檢查是否自動禁言）；DB 不可用回 null */
async function checkUserMuted(userId) {
  const prisma = getPrisma();
  if (!prisma) return null;
  try {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { muted: true } });
    return u ? u.muted : null;
  } catch {
    return null;
  }
}

async function closeDb() {
  if (_prisma) {
    try {
      await _prisma.$disconnect();
    } catch {
      /* ignore */
    }
    _prisma = null;
  }
}

/** 將 IllegalPacketLog 檢查結果轉成人類可讀字串供報告 */
function describeLogCheck(result, violation) {
  if (result === 'found') return `IllegalPacketLog 已落庫（${violation}）`;
  if (result === 'not_found') return `IllegalPacketLog 查無 ${violation}（請確認 DATABASE_URL 指向後端同一 DB）`;
  return `IllegalPacketLog 檢查略過（未設定 DATABASE_URL 或 DB 不可達）`;
}

module.exports = {
  TARGET_URL,
  API,
  C,
  log,
  sleep,
  uuid,
  hmacSign,
  slotCanonical,
  rouletteCanonical,
  pingBackend,
  requireBackend,
  registerAndLogin,
  signSpin,
  sendSpin,
  connectSocket,
  checkIllegalPacketLog,
  checkUserMuted,
  describeLogCheck,
  closeDb,
};
