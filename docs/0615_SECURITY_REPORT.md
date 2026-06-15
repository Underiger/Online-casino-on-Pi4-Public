# Virtual Casino Sandbox — 安全漏洞報告

| 項目 | 內容 |
| --- | --- |
| 報告日期 | 2026-06-15 |
| 報告範圍 | 技術棧相依套件 CVE 掃描（Fastify、Vue 3、Node.js 20、Prisma、PostgreSQL 16、Redis 7、Socket.IO、BullMQ、Nginx） |
| 方法 | 對照 `package-lock.json` 實際解析版本 + Docker image tag，並針對 2025-01 至 2026-06 公開揭露之 CVE 進行網路檢索 |
| 評級標準 | 以 CVSS v3.1 基礎分數標示；**CVSS ≥ 7.0 列為高優先**。另附「對本專案的實際影響」做架構性校正 |

> ⚠️ **方法論說明 — 兩種嚴重程度**
> 本報告同時標示「**基礎 CVSS**」（漏洞本身的客觀嚴重度）與「**本專案實際影響**」（依本系統架構修正後的可利用性）。兩者刻意不平均、不混淆：高 CVSS 但本專案無法被利用者，會明確說明緩解原因，但**仍依規則列為需追蹤項目**。

---

## 一、執行摘要

**整體結論：npm 相依樹維護良好，主要風險集中在「浮動 Docker image tag」。**

`package-lock.json` 顯示所有 npm 套件實際解析到的版本均已涵蓋目前已知 CVE 的修補（vite 6.4.3、axios 1.17.0、fastify 5.8.5、zod 3.25.76、socket.io 4.8.3 / engine.io 6.6.8、vue 3.5.38）。專案也已透過 `overrides.fast-uri` 主動管理傳遞相依，顯示供應鏈衛生良好。

**真正的風險來自基礎設施映像使用浮動標籤**（`redis:7-alpine`、`postgres:16-alpine`、`node:20-alpine`、`nginx:1.27-alpine`）。浮動標籤的安全性只等於「最後一次 `docker pull` / rebuild 的時間點」——若主機在 2025-10-03 之前拉取 Redis 映像且未重新拉取，即執行著 **CVSS 10.0 的 RCE 漏洞（RediShell）**。

### 優先處理清單

| # | 漏洞 | 元件 | 基礎 CVSS | 本專案實際影響 | 狀態 |
| --- | --- | --- | --- | --- | --- |
| 1 | **CVE-2025-49844**（RediShell，Lua UAF RCE） | `redis:7-alpine` | **10.0 嚴重** | **高**（浮動標籤＋無 AUTH） | ⚠️ 需立即處置 |
| 2 | CVE-2025-1094（psql 多位元組編碼 SQLi） | `postgres:16-alpine` | 8.1 高 | 低（Prisma 參數化查詢） | ⚠️ 需確認映像版本 |
| 3 | CVE-2025-59464 等（TLS DoS／HTTP 走私） | `node:20-alpine` | 7.5 高（多項） | 中（nginx 前置部分緩解） | ⚠️ 需 rebuild |
| 4 | CVE-2026-40175 / CVE-2025-62718（axios SSRF） | axios | **10.0 / 嚴重** | **極低**（前端專用、lockfile 已修補 1.17.0） | ✅ 已修補，需對齊 admin 範圍 |
| 5 | CVE-2026-39363（Vite WebSocket 任意檔讀取） | vite | 嚴重 | 極低（lockfile 已 6.4.3、僅 dev server） | ✅ 已修補 |
| 6 | CVE-2025-23419（nginx mTLS session 繞過） | `nginx:1.27-alpine` | 7.4 高 | **無**（未啟用 client cert 驗證） | ✅ 不適用 |
| 7 | Fastify Content-Type 驗證繞過 | fastify | 5.x | 無（已 5.8.5） | ✅ 已修補 |
| 8 | CVE-2023-4316（zod email ReDoS） | zod | 7.5 高 | 無（已 3.25.76） | ✅ 已修補 |

---

## 二、版本快照（實際解析版本）

| 元件 | package.json 宣告 | **lockfile / image 實際** | 來源 |
| --- | --- | --- | --- |
| Fastify | `^5.8.5` | **5.8.5** | `package-lock.json:4115` |
| @fastify/jwt | `^10.1.0` | **10.1.0** | `package-lock.json:1091` |
| Vue | `^3.4.31` | **3.5.38** | `package-lock.json:7535` |
| vue-router（player） | `^5.1.0` | **5.1.0** | `package-lock.json:7556` |
| vue-router（admin） | `^4.4.5` | 4.x | `admin-frontend/package.json:21` |
| axios | `^1.17.0`／admin `^1.7.9` | **1.17.0**（單一 hoist） | `package-lock.json:2869` |
| Vite | `^6.4.2` | **6.4.3** | `package-lock.json:6899` |
| socket.io | `^4.8.3` | **4.8.3** | `package-lock.json:6090` |
| engine.io（傳遞） | — | **6.6.8** | `package-lock.json:3445` |
| BullMQ | `^5.78.0` | **5.78.0** | `package-lock.json:2972` |
| ioredis | `^5.10.1` | **5.10.1** | `package-lock.json:4605` |
| @prisma/client | `^5.22.0` | **5.22.0** | `package-lock.json:1564` |
| zod | `^3.23.8` | **3.25.76** | `package-lock.json:7853` |
| Node.js | `>=20.0.0` | `node:20-alpine`（浮動） | `backend/Dockerfile:11` |
| PostgreSQL | — | `postgres:16-alpine`（浮動） | `docker-compose.arm64.yml:22` |
| Redis | — | `redis:7-alpine`（浮動） | `docker-compose.arm64.yml:46` |
| Nginx | — | `nginx:1.27-alpine`（浮動） | `docker-compose.arm64.yml:110` |

---

## 三、高優先漏洞詳述（CVSS ≥ 7.0）

### 🔴 1. CVE-2025-49844 — Redis「RediShell」Lua Use-After-Free RCE

- **基礎嚴重程度**：**CVSS 10.0（嚴重）**——可能的最高分。
- **元件 / 版本**：`redis:7-alpine`（浮動標籤）。修補版本：Redis **7.2.11 / 7.4.6**（以及 6.2.20、8.0.4、8.2.2）。
- **漏洞說明**：Redis Lua 腳本子系統存在已潛伏約 13 年的 use-after-free 記憶體破壞。具備執行 Lua 腳本權限的使用者可送出特製腳本操控 GC，提前釋放記憶體，逃逸腳本沙箱並在 `redis-server` 程序內執行原生程式碼。2025-10-03 由 Redis 官方揭露（Wiz 於 Pwn2Own Berlin 發現）。
- **影響範圍（本專案）**：
  - **本系統重度使用 Lua**：BullMQ 的佇列原子操作（`backend` 透過 `ioredis` + `@socket.io/redis-adapter`）即以 Lua 腳本實作，亦即 Lua 子系統必然啟用。
  - **無 AUTH**：`docker-compose.arm64.yml` 與 `docker-compose.yml` 的 redis 服務皆未設定 `--requirepass` 或 ACL。
  - **緩解（已存在）**：生產 `docker-compose.arm64.yml` 將 redis 置於 `internal` bridge 網路且**未對宿主機發布 port**，僅 app 容器可達——大幅降低外部觸及面。
  - **風險（仍存在）**：①開發用 `docker-compose.yml:35` 將 `6379` 對 localhost 發布；②浮動 `7-alpine` 標籤若映像於 2025-10 前拉取且未更新，即為易受攻擊版本；③任何能在內網/app 容器執行 Redis 指令的途徑（例如應用層注入）即可利用。
- **修復建議（最高優先）**：
  1. **釘選版本並重新拉取**：將 `redis:7-alpine` 改為 `redis:7.4.6-alpine`（或更新的 7.4.x；如評估升級則 `redis:8.2-alpine`），執行 `docker compose -f docker-compose.arm64.yml pull redis && ... up -d redis`。
  2. **驗證版本**：`docker exec casino-redis redis-cli INFO server | grep redis_version`，確認 ≥ 7.4.6。
  3. **縱深防禦——啟用 AUTH**：於 redis `command` 加入 `--requirepass ${REDIS_PASSWORD}`（密鑰由既有 `scripts/gen-secrets.sh` 產生），並同步更新 `REDIS_URL`。
  4. 維持內網隔離；確認開發環境不將 6379 暴露於不受信任網段。

### 🟠 2. CVE-2025-1094 — PostgreSQL psql 多位元組編碼 SQL Injection

- **基礎嚴重程度**：**CVSS 8.1（高）**。
- **元件 / 版本**：`postgres:16-alpine`（浮動）。修補版本：PostgreSQL **16.7**（含 17.3 / 15.11 等）。
- **漏洞說明**：`PQescapeLiteral()` / `PQescapeString()` 等跳脫函式與 `psql` 在 BIG5、EUC_TW、MULE_INTERNAL 等多位元組編碼下，引號中和不完全，可繞過跳脫達成 SQL 注入；已有真實世界利用案例。
- **影響範圍（本專案）**：**低**。
  - 應用層透過 **Prisma**（參數化查詢，不使用 libpq 跳脫函式或 `psql` 拼接），主要注入面不適用。
  - 唯一需留意者為運維腳本若以 `psql` 處理不受信任輸入，或資料庫使用上述多位元組編碼（本專案應為 UTF8）。
- **修復建議**：
  1. 釘選並重拉：`postgres:16-alpine` → `postgres:16.7-alpine` 或更新；`docker compose pull postgres`。
  2. 驗證：`docker exec casino-postgres psql -U casino -c 'SHOW server_version;'`，確認 ≥ 16.7。
  3. 確認 `server_encoding = UTF8`；維持 Prisma 參數化，避免任何 `psql` 字串拼接帶入外部輸入。

### 🟠 3. Node.js 20 — 多項 2025/2026 安全更新（TLS DoS、HTTP 請求走私、權限繞過）

- **基礎嚴重程度**：**CVSS 7.5（高，多項）** + 中／低數項。
- **元件 / 版本**：`node:20-alpine`（浮動）。最近安全發布：2026-01-13（另有 2025-07、2025-05）。
- **相關 CVE**：
  - **CVE-2025-59464** — TLS client certificate 記憶體洩漏，可對處理 TLS client cert 的應用造成遠端 DoS（High）。
  - **HTTP/1 標頭終止請求走私** — 以 `\r\n\rX` 取代 `\r\n\r\n` 不當終止標頭，可繞過代理式存取控制（**對本專案相關**：nginx → node 反向代理架構）。
  - **CVE-2026-21636 / CVE-2026-21637** — `--permission` 模型下 Unix Domain Socket 繞過、TLS PSK/ALPN callback 例外導致 DoS 與 FD 洩漏。
- **影響範圍（本專案）**：**中**。
  - TLS 由 nginx 終止（`tls.conf`），node 本身通常不直接處理外部 TLS／client cert，降低 CVE-2025-59464 觸及面。
  - **HTTP 請求走私需重視**：本架構為 nginx 反向代理至 `app:3000`，請求走私可能繞過 nginx 層的限流／存取控制（`ratelimit.conf` 的 auth/api zone）。
- **修復建議**：
  1. **Rebuild 後端映像**以拉取最新 20.x 安全版（2026-01-13 發布）：釘選 `FROM node:20-alpine` → 具體 patch（如 `node:20.19-alpine` 或當前最新 20.x），於 `backend/Dockerfile:11` 與 `:34` 兩個 stage 同步更新。
  2. 驗證：`docker run --rm casino-backend:latest node -v`。
  3. 維持 nginx 嚴格代理設定；若使用 `--permission` 模型須一併更新。

### 🟡 4. axios SSRF 系列（CVE-2026-40175 / CVE-2025-62718 / CVE-2025-27152、DoS CVE-2025-58754）

- **基礎嚴重程度**：CVE-2026-40175 **CVSS 10.0（嚴重）**；其餘 High/Medium。
- **元件 / 版本**：lockfile 解析 **axios 1.17.0**（修補版本：SSRF 鏈於 **1.15.0** 修復；DoS 於相應版本修復）。**實際已修補。**
- **漏洞說明**：NO_PROXY 主機名正規化不當（`localhost.`、`[::1]`）導致 SSRF／proxy 繞過；絕對 URL 造成 SSRF 與憑證外洩；缺乏資料大小檢查造成 DoS。
- **影響範圍（本專案）**：**極低**。
  - axios **僅存在於前端**（`frontend`、`admin-frontend`），**後端 `package.json` 未使用 axios**。SSRF 類漏洞的威脅模型針對「伺服器端發出請求 + proxy/NO_PROXY 設定」，瀏覽器 SPA 情境下不成立。
  - lockfile 已 hoist 至單一 `axios@1.17.0`（> 1.15.0），即便 `admin-frontend` 宣告 `^1.7.9` 也共用此已修補版本。
- **修復建議（衛生性、低優先）**：
  1. 將 `admin-frontend/package.json:19` 的 `axios` 範圍由 `^1.7.9` 對齊為 `^1.17.0`，避免日後若 admin 獨立安裝（分離 lockfile/CI）誤解析到易受攻擊的 1.7.x。
  2. 維持 `npm audit` 於 CI 把關。

### 🟡 5. CVE-2026-39363 — Vite Dev Server WebSocket 任意檔案讀取

- **基礎嚴重程度**：嚴重（Critical，任意檔讀取）。
- **元件 / 版本**：lockfile 解析 **vite 6.4.3**。修補版本：**6.4.2** / 7.3.2 / 8.0.5。**實際已修補**（6.4.3 > 6.4.2）。
- **漏洞說明**：6.0.0 至 < 6.4.2，若無 Origin 標頭即可連上 dev server WebSocket，透過 `vite:invoke` 事件呼叫 `fetchModule` 搭配 `file://...?raw` 讀取任意檔案，繞過 `server.fs.allow`。同系列另含 CVE-2025-30208 等（已於 6.2.3 修補，本專案 6.4.3 亦涵蓋）。
- **影響範圍（本專案）**：**極低**。①lockfile 已 6.4.3；②**僅影響 dev server**——生產以 `vite build` 產出靜態檔，由 nginx 提供（`docker-compose.arm64.yml:121-122`），生產環境不執行 dev server。
- **修復建議**：維持 `^6.4.2`（目前 6.4.3 已安全）；開發時勿將 Vite dev server（含 HMR WebSocket）暴露於不受信任網段（避免 `--host 0.0.0.0` 對外）。

### 🟢 6. CVE-2025-23419 — Nginx TLS Session Resumption 繞過 client cert 驗證

- **基礎嚴重程度**：**CVSS 7.4（高）**。
- **元件 / 版本**：`nginx:1.27-alpine`（浮動）。修補版本：**1.27.4**（及 1.26.3）。
- **影響範圍（本專案）**：**無 / 不適用**。
  - 此漏洞僅在「啟用 client certificate 驗證（`ssl_verify_client`）+ 多個 server block 共用 IP/port + 啟用 session 票證」時可利用。
  - 本專案 **未使用 mTLS client cert 驗證**（認證採 JWT/cookie），且 `tls.conf:21` 已設定 **`ssl_session_tickets off`**（正好是官方建議緩解之一）。
  - 另：`nginx.conf:60` 已 `server_tokens off`，`tls.conf` 僅允許 TLS 1.2/1.3 + AEAD ciphers——nginx 整體加固良好。
- **修復建議（衛生性）**：仍建議將 `nginx:1.27-alpine` 釘選至 `nginx:1.27.4-alpine`（或更新的 1.27.x / 1.28 stable）以涵蓋其他累積修補；無需變更 TLS 設定。

---

## 四、已修補 / 不適用項目（驗證留痕）

| 項目 | CVE / 議題 | 判定 | 依據 |
| --- | --- | --- | --- |
| Fastify | Content-Type tab 字元驗證繞過（< 5.7.2）；fastify-reply-from CVE-2025-66415 | **已修補 / 未使用** | lockfile **5.8.5** > 5.7.2；未使用 `@fastify/middie`、`@fastify/csrf-protection`、`fastify-reply-from` |
| zod | CVE-2023-4316（email regex ReDoS，< 3.22.3） | **已修補** | lockfile **3.25.76** |
| Socket.IO / engine.io | CVE-2024-38355（DoS）等舊版議題 | **目前版本** | socket.io **4.8.3**（最新）、engine.io **6.6.8**（最新） |
| Vue | CVE-2024-6783（prototype pollution XSS） | **不適用** | 該漏洞屬 Vue 2 `vue-template-compiler`；本專案 Vue **3.5.38** |
| Prisma | `getPackedPackage` RCE | **不適用** | 僅影響 CLI 建置/測試路徑，非 runtime；惟 5.22 已落後（v6 已釋出），建議排程升級 |
| argon2 / otplib / ioredis / BullMQ | — | **無已知高危 CVE** | 維持現行版本；BullMQ/ioredis 之真實風險向量為後端 Redis 本身（見 §三.1） |
| esbuild | GHSA-gv7w-rqvm-qjhr（Deno 模組二進位下載缺少完整性驗證，< 0.28.1；Dependabot alert #1，2026-06-12 揭露；**CVSS 8.1**） | **不適用 / 已修補** | lockfile 解析 **0.28.1**（修補版）；漏洞攻擊路徑限於 Deno 執行環境（`NPM_CONFIG_REGISTRY` 劫持），本專案為 Node.js npm 安裝，向量不成立 |
| ws | CVE-2026-48779 GHSA-96hv-2xvq-fx4p（tiny-fragment 記憶體耗盡 DoS，>= 8.0.0, < 8.21.0；Dependabot alert #2；**CVSS 7.5**） | ✅ **已修補** | overrides 釘選 `ws@^8.21.0`；lockfile 已解析 **8.21.0**（2026-06-16）。後端 socket.io/engine.io 使用 ws，DoS 向量確實存在，需修補。 |
| form-data | CVE-2026-12143 GHSA-hmw2-7cc7-3qxx（multipart 欄位名未跳脫 CRLF 注入，>= 4.0.0, < 4.0.6；Dependabot alert #3；**CVSS 7.5**） | ✅ **已修補** | overrides 釘選 `form-data@^4.0.6`；lockfile 已解析 **4.0.6**（2026-06-16）。axios 傳遞依賴，前端 SPA 走原生 FormData，實際影響極低；仍一併修補。 |

---

## 五、修復行動清單（依優先序）

**P0 — 立即（本週）**
- [ ] Redis：`redis:7-alpine` → `redis:7.4.6-alpine`（或更新），`docker compose pull` 後重啟並以 `INFO server` 驗證版本 ≥ 7.4.6。
- [ ] Redis：新增 `--requirepass`/ACL（縱深防禦），更新 `REDIS_URL`。
- [ ] 稽核所有部署主機的 Redis 映像實際 build/pull 日期（2025-10-03 前者高度可疑）。

**P1 — 短期（本迭代）**
- [ ] PostgreSQL：釘選 `postgres:16.7-alpine`+ 並重拉、驗證版本。
- [ ] Node.js：rebuild 後端映像拉取 2026-01 安全版；`backend/Dockerfile` 兩處 `FROM node:20-alpine` 釘選具體 patch。
- [ ] Nginx：釘選 `nginx:1.27.4-alpine`+（衛生性，TLS 設定無需更動）。

**P2 — 衛生性 / 排程**
- [x] 對齊 `admin-frontend` 的 axios 範圍至 `^1.17.0`。（2026-06-16 完成）
- [ ] 統一 player / admin 的 vue-router 大版本（player 5.1.0 vs admin 4.4.5），降低維護分歧。
- [ ] 排程評估 Prisma 5 → 6 升級。
- [ ] **流程改善**：將所有 Docker tag 由浮動（`7-alpine`）改為釘選 patch 版本或 digest；於 CI 導入映像掃描（Trivy/Grype）+ `npm audit` / Dependabot；建立每月「重拉映像 + rebuild + 掃描」例行。

> 💡 **根因建議**：本次最嚴重風險（RediShell CVSS 10.0）並非「用了過舊套件」，而是**浮動 image tag 讓安全狀態不可預測**。釘選版本 + 自動掃描可從制度面消除此類「未知是否已修補」的不確定性，符合「大聲報錯、不默默帶過」原則。

---

## 六、來源

- Redis RediShell：[Redis 官方安全公告 CVE-2025-49844](https://redis.io/blog/security-advisory-cve-2025-49844/) ・ [GHSA-4789-qfc9-5f9q](https://github.com/redis/redis/security/advisories/GHSA-4789-qfc9-5f9q) ・ [Wiz 研究](https://www.wiz.io/blog/wiz-research-redis-rce-cve-2025-49844) ・ [Sysdig 分析](https://www.sysdig.com/blog/cve-2025-49844-redishell)
- PostgreSQL CVE-2025-1094：[Rapid7](https://www.rapid7.com/blog/post/2025/02/13/cve-2025-1094-postgresql-psql-sql-injection-fixed/) ・ [ARMO](https://www.armosec.io/blog/cve-2025-1094-postgresql-sql-injection-vulnerability/)
- Node.js 安全發布：[2026-01-13](https://nodejs.org/en/blog/vulnerability/december-2025-security-releases) ・ [2025-07-15](https://nodejs.org/en/blog/vulnerability/july-2025-security-releases) ・ [2025-05-14](https://nodejs.org/en/blog/vulnerability/may-2025-security-releases)
- axios SSRF：[CSA Singapore AL-2026-037](https://www.csa.gov.sg/alerts-and-advisories/alerts/al-2026-037/) ・ [CVE-2025-27152 (GHSA-jr5f-v2jv-69x6)](https://github.com/advisories/ghsa-jr5f-v2jv-69x6) ・ [HeroDevs 升級指南](https://www.herodevs.com/blog-posts/axios-versions-cves-and-safe-upgrade-path-updated-april-2026) ・ [IBM Bulletin CVE-2025-62718/CVE-2026-40175](https://www.ibm.com/support/pages/security-bulletin-ibm-app-connect-enterprise-vulnerable-specific-gadget-attack-chain-and-proxy-bypass-and-ssrf-vulnerabilities-due-node-js-module-axios-cve-2025-62718-cve-2026-40175-0)
- Vite：[CVE-2026-39363 (GHSA-p9ff-h696-f583)](https://github.com/advisories/GHSA-p9ff-h696-f583) ・ [CVE-2025-30208 OffSec](https://www.offsec.com/blog/cve-2025-30208/)
- Fastify：[CVE-2026-6270 (@fastify/middie) ZeroPath](https://zeropath.com/blog/cve-2026-6270-fastify-middie-auth-bypass) ・ [Fastify CVE 列表 (cvedetails)](https://www.cvedetails.com/vulnerability-list/vendor_id-20791/Fastify.html)
- Socket.IO：[socket.io GHSA #5484](https://github.com/socketio/socket.io/issues/5484) ・ [Snyk engine.io](https://security.snyk.io/package/npm/engine.io)
- Nginx：[CVE-2025-23419 Snyk](https://security.snyk.io/vuln/SNYK-UNMANAGED-NGINX-8705416) ・ [F5 K000149173](https://my.f5.com/manage/s/article/K000149173)
- zod：[CVE-2023-4316 Snyk](https://security.snyk.io/vuln/SNYK-JS-ZOD-5925617)
- Vue：[CVE-2024-6783 SentinelOne](https://www.sentinelone.com/vulnerability-database/cve-2024-6783/)
- esbuild：[GHSA-gv7w-rqvm-qjhr（esbuild 官方 advisory）](https://github.com/evanw/esbuild/security/advisories/GHSA-gv7w-rqvm-qjhr)
- ws：[CVE-2026-48779 GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p)
- form-data：[CVE-2026-12143 GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx)

---

*本報告針對相依套件 CVE，未涵蓋應用層邏輯弱點（authz、業務規則、RNG 公平性等）；後者請另見 M27 安全演練文件與滲透測試。*
