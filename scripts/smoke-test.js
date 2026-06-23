#!/usr/bin/env node
'use strict';
/**
 * scripts/smoke-test.js — Pi 4 真機部署冒煙測試（05_MILESTONES M28 DoD）。
 *
 * 對「已部署、由 Nginx 前置的完整生產堆疊」發出最小關鍵路徑請求，驗證真機上的
 * 接線正確：Nginx TLS 終止 →（/health）→ /api 反向代理 → 後端 → PostgreSQL（寫使用者）
 * → Redis（會話金鑰 / 限流）→ HMAC 防作弊鏈 → 餘額異動 → Socket.IO WSS 升級。
 *
 * 與 `npm test`（fake PG/Redis 的單元 / 整合測試）互補：本腳本只在「真服務 + 真機」
 * 上才有意義——驗的是部署接線，不是商業邏輯。
 *
 * 用法（堆疊已 `docker compose -f docker-compose.arm64.yml ... up -d` 之後）：
 *   node scripts/smoke-test.js                 # 預設打 https://localhost（經 Nginx 443）
 *   npm run test:smoke
 *   SMOKE_TARGET_URL=https://casino.example.com SMOKE_TLS_VERIFY=1 npm run test:smoke
 *
 * 環境變數：
 *   SMOKE_TARGET_URL   目標 base URL（預設 https://localhost；經 Nginx 443 終止 TLS）
 *   SMOKE_TLS_VERIFY   設為 1 才驗證 TLS 憑證（預設 0，因 gen-cert.sh 為自簽；
 *                      換上 Let's Encrypt 正式憑證後應設 1 以連憑證鏈一併驗收）
 *   SMOKE_BET          spin 下注額（預設 10；須 ≤ 新帳號初始餘額）
 *
 * 結束碼：全部關鍵路徑通過 → 0；任一關鍵檢查失敗 → 1（deploy.sh / CI 可據此 gate）。
 *
 * 相依：Node 20 內建 fetch / crypto；Socket.IO 步驟需 socket.io-client（後端 workspace
 *      既有相依，root `npm install` 後可用；缺則該步驟跳過並告警，不影響結束碼）。
 *      HMAC 簽章複用 security-attacks/lib/common.js（與後端 security/hmac.ts 同義，單一來源）。
 */
const crypto = require('node:crypto');
const { C, log, hmacSign, slotCanonical } = require('./security-attacks/lib/common.js');

const BASE = (process.env.SMOKE_TARGET_URL || 'https://localhost').replace(/\/$/, '');
const API = `${BASE}/api`;
const TLS_VERIFY = process.env.SMOKE_TLS_VERIFY === '1';
const BET = Number.parseInt(process.env.SMOKE_BET || '10', 10);

// gen-cert.sh 產生自簽憑證：預設略過 TLS 驗證（涵蓋 fetch 與 socket.io-client 的 TLS）。
// 正式上線（Let's Encrypt）請設 SMOKE_TLS_VERIFY=1，連憑證鏈一併驗收。
if (!TLS_VERIFY) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const uuid = () => crypto.randomUUID();
let failures = 0;
let warnings = 0;

// ─────────────────────────── 步驟執行器 ───────────────────────────

/** 獨立檢查：失敗只記錄不中止。fn 回傳明細字串或 { skip } 或拋例外。 */
async function independent(name, fn) {
  try {
    const detail = await fn();
    if (detail && detail.skip) {
      warnings += 1;
      log.warn(`${name} — ${detail.skip}`);
      return;
    }
    log.ok(detail ? `${name} — ${detail}` : name);
  } catch (err) {
    failures += 1;
    log.fail(`${name} — ${err.message}`);
  }
}

/** 相依鏈步驟：成功回傳 value 供後續使用，失敗記錄並回傳 null（呼叫端據此中止鏈）。 */
async function guard(name, fn) {
  try {
    const { value, detail } = await fn();
    log.ok(detail ? `${name} — ${detail}` : name);
    return value;
  } catch (err) {
    failures += 1;
    log.fail(`${name} — ${err.message}`);
    return null;
  }
}

// ─────────────────────────── HTTP 工具 ───────────────────────────

async function postJson(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 無 JSON body */
  }
  return { status: res.status, json };
}

// ─────────────────────────── 檢查項 ───────────────────────────

/** 1. Nginx /health（驗 TLS 終止 + Nginx 在線）；site.conf 回 200 純文字 "ok"。 */
async function checkHealth() {
  const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) });
  if (res.status !== 200) throw new Error(`預期 200，實得 ${res.status}`);
  const text = (await res.text()).trim();
  if (text !== 'ok') throw new Error(`預期 body "ok"，實得 "${text.slice(0, 40)}"`);
  return `${BASE}/health → 200 ok`;
}

/** 2. 公開 API（驗 Nginx → 後端 /api 反向代理）；GET /api/leaderboard/total 免授權。 */
async function checkPublicApi() {
  const res = await fetch(`${API}/leaderboard/total`, { signal: AbortSignal.timeout(8000) });
  if (res.status !== 200) throw new Error(`GET /api/leaderboard/total 預期 200，實得 ${res.status}`);
  // 必須是 JSON（若 SPA fallback 回 HTML 則代表代理規則錯置）
  await res.json();
  return '/api/* 反向代理正常';
}

/** 3. 註冊新玩家（驗 PostgreSQL 寫入）。 */
async function register() {
  const username = `smoke_${crypto.randomBytes(5).toString('hex')}`.slice(0, 20);
  const password = 'Smoke#Test2026';
  const { status, json } = await postJson('/auth/register', { username, password });
  if (status !== 201) {
    throw new Error(`register 預期 201，實得 ${status}${json ? ` ${JSON.stringify(json).slice(0, 80)}` : ''}`);
  }
  if (!json || !json.user || !json.user.id) throw new Error('register 回應缺 user.id');
  return { value: { username, password, userId: json.user.id }, detail: `userId ${json.user.id.slice(0, 8)}…` };
}

/** 4. 登入（驗 JWT 簽發 + Redis 下發 HMAC 會話金鑰）。 */
async function login(acct) {
  const { status, json } = await postJson('/auth/login', { username: acct.username, password: acct.password });
  if (status !== 200) throw new Error(`login 預期 200，實得 ${status}`);
  if (!json || !json.accessToken) throw new Error('login 回應缺 accessToken');
  if (!json.hmacKey) {
    throw new Error('login 未下發 hmacKey（Redis 可能離線——生產環境下 HMAC 防線將失效）');
  }
  return { value: json, detail: 'JWT + hmacKey 已下發' };
}

/** 5. HMAC 簽章 spin（驗完整防作弊鏈 + 餘額異動 + BetRecord 落庫）。 */
async function spin(session) {
  const nonce = uuid();
  const ts = Date.now();
  const sig = hmacSign(session.hmacKey, slotCanonical(session.userId, BET, nonce, ts));
  const res = await fetch(`${API}/slot/spin`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`,
      'x-sig': sig,
      'x-nonce': nonce,
      'x-ts': String(ts),
      'x-seq': '1',
    },
    body: JSON.stringify({ betAmount: BET }),
    signal: AbortSignal.timeout(10000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 無 JSON body */
  }
  if (res.status !== 200) {
    const code = json && json.error && json.error.code;
    throw new Error(`spin 預期 200，實得 ${res.status}${code ? ` (${code})` : ''}`);
  }
  const bal = json && (json.balanceAfter ?? json.balance);
  return { value: json, detail: bal != null ? `餘額 ${bal}` : '防作弊鏈通過' };
}

/** 6. Socket.IO WSS 升級（驗 Nginx /socket.io/ proxy + Upgrade 標頭 + 握手鑑權）。 */
async function socketCheck(session) {
  let ioClient;
  try {
    ioClient = require('socket.io-client');
  } catch {
    return { skip: 'socket.io-client 未安裝（root npm install 後可驗）——已跳過' };
  }
  const io = ioClient.io || ioClient.default || ioClient;
  await new Promise((resolve, reject) => {
    const socket = io(BASE, {
      path: '/socket.io/',
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token: session.accessToken },
      timeout: 8000,
      rejectUnauthorized: TLS_VERIFY,
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('連線逾時（8s）'));
    }, 8000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.close();
      resolve();
    });
    socket.once('connect_error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`連線被拒：${err.message}`));
    });
  });
  return 'WSS 升級 + 握手鑑權成功';
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  log.section(`Pi 4 部署冒煙測試 → ${BASE}${TLS_VERIFY ? '' : C.gray + '（自簽：略過 TLS 驗證）' + C.reset}`);

  // Phase 1：基礎可達性（互相獨立）
  await independent('Nginx /health（TLS 終止）', checkHealth);
  await independent('Nginx → 後端 /api 反向代理', checkPublicApi);

  // Phase 2：玩家關鍵路徑（相依鏈，任一失敗即中止後續）
  let session = null;
  const acct = await guard('註冊新玩家（PostgreSQL 寫入）', register);
  if (acct) {
    const creds = await guard('登入（JWT + HMAC 金鑰 / Redis）', () => login(acct));
    if (creds) {
      session = { userId: acct.userId, accessToken: creds.accessToken, hmacKey: creds.hmacKey };
      await guard(`HMAC 簽章 spin（下注 ${BET}；防作弊鏈 + 餘額異動）`, () => spin(session));
    }
  }

  // Phase 3：即時通道（需 session）
  if (session) {
    await independent('Socket.IO WSS 升級（經 Nginx）', () => socketCheck(session));
  } else {
    warnings += 1;
    log.warn('Socket.IO WSS 升級 — 前置登入未完成，已跳過');
  }

  // 總結
  log.section('結果');
  if (failures === 0 && warnings === 0) {
    log.ok('全部關鍵路徑通過 ✅');
  } else {
    if (failures > 0) log.fail(`${failures} 項關鍵檢查失敗`);
    if (warnings > 0) log.warn(`${warnings} 項已跳過 / 告警`);
  }
  console.log('');
  process.exitCode = failures > 0 ? 1 : 0;
}

main().catch((err) => {
  log.fail(`冒煙測試未預期中止：${err.message}`);
  process.exitCode = 1;
});
