/**
 * Virtual Casino Sandbox — 種子腳本（M02）
 *
 * 內容（05_MILESTONES M02）：
 *   - Jackpot 單行（id=1；migration 已含 ON CONFLICT 種子，此處 upsert 雙保險）
 *   - 初版護符池 12 枚（WEIGHT/RULE/CONDITIONAL/PITY/BONUS 五型，01_GDD §3.3）
 *   - 每日任務池 7 則（01_GDD §5.1：任務池抽 3 則）
 *   - 成就 12 個（01_GDD §5.4）
 *   - Admin 帳號（argon2id；密碼取自 ADMIN_INITIAL_PASSWORD）
 *
 * 冪等性：全部使用 upsert（以 unique code / username / id 為鍵），重跑不產生重複資料。
 *
 * 雙 provider 相容：
 *   - enum 欄位一律以字串字面值寫入（PG 生成的 enum 型別是字串字面值聯集，直接相容）
 *   - Json 欄位經 j() 包裝：PG 存原生 Json，SQLite（無 Json 型別）存 JSON.stringify 字串
 *
 * 執行方式：
 *   PG     ：cd backend && npx prisma migrate dev（自動觸發）或 npm run prisma:seed
 *   SQLite ：npm run prisma:push:sqlite && npm run prisma:generate:sqlite
 *            && DATABASE_URL=file:./prisma/dev.sqlite npm run prisma:seed
 */
import { PrismaClient } from '@prisma/client';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';

// 直接以 tsx 執行時補載 monorepo 根目錄 .env（prisma CLI 不會往上層找）
if (!process.env.DATABASE_URL) {
  const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
}

const DATABASE_URL = process.env.DATABASE_URL ?? '';
if (!DATABASE_URL) {
  console.error('DATABASE_URL 未設定。請建立根目錄 .env 或以環境變數傳入。');
  process.exit(1);
}

const IS_SQLITE = DATABASE_URL.startsWith('file:');

/** Json 欄位包裝：PG 存原生 Json；SQLite schema 該欄位為 String，存序列化字串 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (value: unknown): any => (IS_SQLITE ? JSON.stringify(value) : value);

const prisma = new PrismaClient();

// ─────────────────────── 護符池 12 枚（01_GDD §3.3.1 五型） ───────────────────────
const CHARMS = [
  // WEIGHT 權重型：修改某符號在某些轉軸的出現權重
  {
    code: 'CHERRY_RAIN_40',
    name: '櫻桃雨',
    description: '櫻桃在全部轉軸的出現權重 +40%',
    type: 'WEIGHT',
    rarity: 'COMMON',
    effect: { symbol: 'CHERRY', reels: [1, 2, 3], multiplier: 1.4 },
  },
  // LUCK 機率型：機率鎖定第3軸為目標符號（自然已三連則不覆寫），不動權重。
  // 2026-06-22 由 WEIGHT 乘數改版：乘數會稀釋櫻桃權重，三連又是 p³ 關係，
  // 乘數一拉高裝備時 RTP 就崩盤（Monte Carlo 驗證 luck=1 顆鎖軸 RTP 91.5%→15~26%）。
  // 數值取「裝備時 RTP ≈ baseline +2~4 點」（見 PR 說明 Monte Carlo 表）。
  {
    code: 'CLOVER_BOOST_30',
    name: '四葉草幸運符',
    description: '有 30% 機率讓第 3 軸直接出現四葉草（已連線則不覆寫）',
    type: 'LUCK',
    rarity: 'COMMON',
    effect: { symbol: 'CLOVER', luck: 30 },
  },
  {
    code: 'BELL_TUNER_30',
    name: '銅鈴調音器',
    description: '有 80% 機率讓第 3 軸直接出現鈴鐺（已連線則不覆寫）',
    type: 'LUCK',
    rarity: 'COMMON',
    effect: { symbol: 'BELL', luck: 80 },
  },
  {
    code: 'BAR_MAGNET_35',
    name: 'BAR 磁鐵',
    description: '有 65% 機率讓第 3 軸直接出現 BAR（已連線則不覆寫）',
    type: 'LUCK',
    rarity: 'RARE',
    effect: { symbol: 'BAR', luck: 65 },
  },
  {
    code: 'SEVEN_CALLER_25',
    name: '七星召喚',
    description: '有 30% 機率讓第 3 軸直接出現 Lucky7（已連線則不覆寫）',
    type: 'LUCK',
    rarity: 'RARE',
    effect: { symbol: 'LUCKY7', luck: 30 },
  },
  {
    code: 'DIAMOND_DUST_20',
    name: '鑽石星塵',
    description: '有 20% 機率讓第 3 軸直接出現鑽石（已連線則不覆寫）',
    type: 'LUCK',
    rarity: 'EPIC',
    effect: { symbol: 'DIAMOND', luck: 20 },
  },
  // RULE 規則型：修改賠付判定規則
  {
    code: 'WILD_UNLOCK',
    name: '萬用之星',
    description: 'Wild 可替代任何符號參與連線判定',
    type: 'RULE',
    rarity: 'EPIC',
    effect: { wildSubstitute: true },
  },
  // CONDITIONAL 條件型：滿足盤面條件時切換到預計算變體表
  {
    code: 'LUCKY7_CHAIN',
    name: '七連鎖',
    description: '前兩軸為 Lucky7 時，第三軸 Lucky7 權重 ×3',
    type: 'CONDITIONAL',
    rarity: 'EPIC',
    effect: {
      trigger: { reel12: 'LUCKY7' },
      variant: { reel: 3, symbol: 'LUCKY7', multiplier: 3 },
    },
  },
  {
    code: 'CLOVER_CHAIN',
    name: '三葉連莖',
    description: '前兩軸為四葉草時，第三軸四葉草權重 ×2.5',
    type: 'CONDITIONAL',
    rarity: 'RARE',
    effect: {
      trigger: { reel12: 'CLOVER' },
      variant: { reel: 3, symbol: 'CLOVER', multiplier: 2.5 },
    },
  },
  // PITY 保底型：基於連續未中獎計數器
  {
    code: 'PITY_CHARM_10',
    name: '不屈之心',
    description: '連續 10 次未中獎後，下次中獎倍率 +50%',
    type: 'PITY',
    rarity: 'RARE',
    effect: { threshold: 10, bonus: 0.5 },
  },
  {
    code: 'PITY_CHARM_7',
    name: '逆轉時刻',
    description: '連續 7 次未中獎後，下次中獎倍率 +50%',
    type: 'PITY',
    rarity: 'LEGENDARY',
    effect: { threshold: 7, bonus: 0.5 },
  },
  // BONUS 獎勵型：中獎後附加效果
  {
    code: 'JACKPOT_MAGNET',
    name: '獎池磁石',
    description: 'Diamond 中獎時額外 +100 Jackpot 點數',
    type: 'BONUS',
    rarity: 'LEGENDARY',
    effect: { onSymbol: 'DIAMOND', jackpotPoints: 100 },
  },
] as const;

// ─────────────────────── 每日任務池（每日抽 3 則；獎勵 200–500） ───────────────────────
const DAILY_TASKS = [
  { code: 'SPIN_20', name: '旋轉 20 次', type: 'SPIN_COUNT', target: 20, rewardCoin: 300n, rewardCharm: false },
  { code: 'SPIN_50', name: '旋轉 50 次', type: 'SPIN_COUNT', target: 50, rewardCoin: 500n, rewardCharm: false },
  { code: 'ROULETTE_5', name: '輪盤下注 5 局', type: 'ROULETTE_ROUNDS', target: 5, rewardCoin: 300n, rewardCharm: false },
  { code: 'ROULETTE_10', name: '輪盤下注 10 局', type: 'ROULETTE_ROUNDS', target: 10, rewardCoin: 500n, rewardCharm: false },
  { code: 'WIN_TRIPLE_1', name: '中獎 1 次三連', type: 'WIN_TRIPLE', target: 1, rewardCoin: 400n, rewardCharm: true },
  { code: 'NET_WIN_1000', name: '單日淨贏 1,000 Coin', type: 'NET_WIN', target: 1000, rewardCoin: 500n, rewardCharm: false },
  { code: 'CHAT_5', name: '聊天室發言 5 則', type: 'CHAT_COUNT', target: 5, rewardCoin: 200n, rewardCharm: false },
] as const;

// ─────────────────────── 成就 12 個（01_GDD §5.4） ───────────────────────
const ACHIEVEMENTS = [
  { code: 'FIRST_TRIPLE', name: '首次三連', description: 'first 三連線中獎達成', rewardCoin: 200n },
  { code: 'LUCKY7_TRIPLE', name: '幸運七降臨', description: 'Lucky7 三連線中獎', rewardCoin: 1000n },
  { code: 'DIAMOND_TRIPLE', name: '鑽石恆久遠', description: 'Diamond 三連線中獎', rewardCoin: 1500n },
  { code: 'WILD_TRIPLE', name: '狂野之夜', description: 'Wild 三連線中獎', rewardCoin: 2000n },
  { code: 'JACKPOT_WINNER', name: 'Jackpot 得主', description: '贏得一次全服 Jackpot', rewardCoin: 5000n },
  { code: 'LOGIN_STREAK_7', name: '七日之約', description: '連續登入 7 天', rewardCoin: 1000n },
  { code: 'SPIN_1000', name: '千轉達人', description: '累計旋轉老虎機 1,000 次', rewardCoin: 800n },
  { code: 'ROULETTE_100', name: '輪盤常客', description: '累計參與輪盤 100 局', rewardCoin: 800n },
  { code: 'NET_WIN_10000', name: '日進斗金', description: '單日淨贏 10,000 Coin', rewardCoin: 1000n },
  { code: 'CHARM_COLLECT_6', name: '收藏家', description: '護符圖鑑收集 6 枚', rewardCoin: 600n },
  { code: 'CHARM_COLLECT_12', name: '大收藏家', description: '護符圖鑑收集全部 12 枚', rewardCoin: 1200n },
  { code: 'CHATTERBOX', name: '聊天室之星', description: '累計發言 100 則', rewardCoin: 300n },
] as const;

async function main(): Promise<void> {
  console.log(`Seeding (provider: ${IS_SQLITE ? 'sqlite' : 'postgresql'}) ...`);

  // 1. Jackpot 單行（migration 已種；upsert 雙保險，SQLite db push 路徑也補上）
  await prisma.jackpot.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, pool: 0n, version: 0 },
  });
  console.log('  - jackpot: id=1 確保存在');

  // 2. 護符池 12 枚
  for (const c of CHARMS) {
    await prisma.charm.upsert({
      where: { code: c.code },
      update: {
        name: c.name,
        description: c.description,
        type: c.type,
        rarity: c.rarity,
        effect: j(c.effect),
      },
      create: {
        code: c.code,
        name: c.name,
        description: c.description,
        type: c.type,
        rarity: c.rarity,
        effect: j(c.effect),
      },
    });
  }
  console.log(`  - charms: ${CHARMS.length} 枚 upsert 完成`);

  // 3. 每日任務池
  for (const t of DAILY_TASKS) {
    await prisma.dailyTask.upsert({
      where: { code: t.code },
      update: {
        name: t.name,
        type: t.type,
        target: t.target,
        rewardCoin: t.rewardCoin,
        rewardCharm: t.rewardCharm,
      },
      create: {
        code: t.code,
        name: t.name,
        type: t.type,
        target: t.target,
        rewardCoin: t.rewardCoin,
        rewardCharm: t.rewardCharm,
      },
    });
  }
  console.log(`  - daily_tasks: ${DAILY_TASKS.length} 則 upsert 完成`);

  // 4. 成就
  for (const a of ACHIEVEMENTS) {
    await prisma.achievement.upsert({
      where: { code: a.code },
      update: { name: a.name, description: a.description, rewardCoin: a.rewardCoin },
      create: { code: a.code, name: a.name, description: a.description, rewardCoin: a.rewardCoin },
    });
  }
  console.log(`  - achievements: ${ACHIEVEMENTS.length} 個 upsert 完成`);

  // 5. Admin 帳號（密碼僅在「首次建立」時寫入；已存在帳號不覆蓋既有密碼）
  const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
  const adminPassword = process.env.ADMIN_INITIAL_PASSWORD ?? 'change_me';
  if (adminPassword === 'change_me') {
    console.warn('  ! ADMIN_INITIAL_PASSWORD 仍為 change_me，請執行 scripts/gen-secrets.sh');
  }
  const passwordHash = await argon2.hash(adminPassword, { type: argon2.argon2id });
  await prisma.user.upsert({
    where: { username: adminUsername },
    update: {}, // 冪等：不覆蓋既有 Admin 的密碼/狀態
    create: {
      username: adminUsername,
      passwordHash,
      role: 'ADMIN',
      balance: 0n, // Admin 不參與遊戲經濟
    },
  });
  console.log(`  - admin: "${adminUsername}" 確保存在（role=ADMIN）`);

  console.log('Seed 完成 ✅');
}

main()
  .catch((err) => {
    console.error('Seed 失敗：', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
