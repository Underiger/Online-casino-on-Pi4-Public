/**
 * 遊戲數值常數（01_GDD §3.2/§3.3、05_MILESTONES M10）。
 *
 * ★ 調參守則（05_MILESTONES §4 風險緩衝）：
 *   權重表 / 賠率表全部集中本檔，M26 RTP 模擬調參只動數值、不動程式邏輯。
 *   任何數值變動必須同步 bump WEIGHT_TABLE_VERSION——
 *   loadoutHash 含版本號，舊 CompiledLoadout 快取自然失效。
 *
 * 與 packages/shared/src/constants.ts 的關係：
 *   注額檔位、PITY/LUCKY 倍率等「前端也需要的展示值」在 shared 另有一份；
 *   backend 暫無法直接 import shared 的 .ts 入口（rootDir 限制，同 sockets/events.ts
 *   檔頭說明），本檔為權威數值來源，shared 側為展示鏡像。
 *
 * RTP 解析計算（三軸同表、無護符、無幸運符號）：
 *   p = w/100；RTP = Σ p³ × 三連倍率 + p(CHERRY)² × (1−p(CHERRY)) × 二連倍率
 *   以下權重代入 ≈ 0.7408(🍒三連) + 0.1397(🍒二連) + 0.0026 + 0.0027
 *               + 0.0026 + 0.0082 + 0.0050 + 0.0075 + 0.0064 ≈ **91.5%**
 *   落在 GDD 目標 92% ± 2 區間（M26 蒙地卡羅 1,000 萬次複核）。
 *   註：GDD §3.3.2 的權重表為「結構示例」（其數值解析 RTP 僅 ~30%，與 §2.4
 *   凍結的 92% 目標矛盾）；本檔以 RTP 目標為準回推數值。
 */

// ─────────────────────────── 符號 ───────────────────────────

/**
 * 轉軸符號（與 packages/shared SlotSymbol enum、GDD §3.2 順序一致）。
 * 以 const tuple 定義（backend 不依賴 shared 的 TS enum）。
 */
export const SLOT_SYMBOLS = [
  'CHERRY',
  'LEMON',
  'BELL',
  'BAR',
  'CLOVER',
  'LUCKY7',
  'DIAMOND',
  'WILD',
] as const;

export type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

// ─────────────────────────── 注額 ───────────────────────────

/** 可選注額三檔（GDD §3.1） */
export const SLOT_BET_AMOUNTS = [10, 50, 100] as const;
export type SlotBetAmount = (typeof SLOT_BET_AMOUNTS)[number];

/** 轉軸數 */
export const SLOT_REEL_COUNT = 3;

// ─────────────────────────── 權重表 ───────────────────────────

/**
 * 權重表版本：任何權重 / 賠率數值變動必須 +1（loadoutHash 的一部分）。
 */
export const WEIGHT_TABLE_VERSION = 1;

/**
 * 每軸基礎權重（GDD §3.3.2：每軸一張靜態表；初版三軸同值，結構保留每軸獨立）。
 * 總和 100。CHERRY 高頻低賠主導 RTP（見檔頭解析計算）。
 */
const BASE_REEL_WEIGHTS: Readonly<Record<SlotSymbol, number>> = {
  CHERRY: 57,
  LEMON: 8,
  BELL: 7,
  BAR: 6,
  CLOVER: 8,
  LUCKY7: 5,
  DIAMOND: 5,
  WILD: 4,
};

/** 三軸權重表（index 0–2 = 第 1–3 軸） */
export const SLOT_BASE_WEIGHTS: ReadonlyArray<Readonly<Record<SlotSymbol, number>>> = [
  BASE_REEL_WEIGHTS,
  BASE_REEL_WEIGHTS,
  BASE_REEL_WEIGHTS,
];

/**
 * 浮點權重 → 整數權重的縮放精度（rngInt 只收整數上限）。
 * 護符乘數（×1.3 等）作用後以此精度取整：57 × 1.3 = 74.1 → 7410 / 精度 100。
 */
export const WEIGHT_PRECISION = 100;

// ─────────────────────────── 賠率表 ───────────────────────────

export interface PaytableRow {
  /** 三連倍率（× 注額） */
  triple: number;
  /** 二連倍率（左起兩格；null = 該符號無二連賠付） */
  double: number | null;
}

/** 賠率表（GDD §3.2 凍結；僅 CHERRY 有二連） */
export const SLOT_PAYTABLE: Readonly<Record<SlotSymbol, PaytableRow>> = {
  CHERRY: { triple: 4, double: 1 },
  LEMON: { triple: 5, double: null },
  BELL: { triple: 8, double: null },
  BAR: { triple: 12, double: null },
  CLOVER: { triple: 16, double: null },
  LUCKY7: { triple: 40, double: null },
  DIAMOND: { triple: 60, double: null },
  WILD: { triple: 100, double: null },
};

// ─────────────────────────── 加成 ───────────────────────────

/** 今日幸運符號：權重 ×1.5（編譯期，GDD §3.3.2 步驟 2） */
export const LUCKY_SYMBOL_WEIGHT_MULTIPLIER = 1.5;

/** 今日幸運符號：該符號形成連線時賠率 ×1.5（結算期，GDD §3.2/§5.1） */
export const LUCKY_SYMBOL_PAYOUT_MULTIPLIER = 1.5;

/** Diamond 三連附加 Jackpot 點數（GDD §3.2） */
export const JACKPOT_POINTS_DIAMOND_TRIPLE = 50;

// ═══════════════════════════ 射龍門 Dragon Gate ═══════════════════════════
//
// 規則：開兩張門牌（門牌不重洗、來自同一副已抽掉 2 張的 52 張牌），閒家下注
// 第三張牌是否「介於」兩門之間（不含門牌本身點數）；剛好等於某張門牌點數視為
// 「踩柱」賠雙倍（多輸一個注額）；其餘（門外）輸掉單注。兩門相鄰或相同（gap=0，
// 無法介於）由 service 層自動重開門，不進入下注流程。
//
// 機率（兩張門牌之外還有 50 張牌；門牌各自剩 3 張、gap 個點數各 4 張未被動過）：
//   P(介於) = gap * 4 / 50
//   P(踩柱) = (3+3) / 50 = 0.12（與 gap 無關，恆定值——CARDS_LEFT_AFTER_DOORS 用此推算）
// 目標 RTP 與 slot 一致（92%），解 multiplier M：
//   P(介於)*(1+M) - 2*P(踩柱) - (1 - P(介於) - P(踩柱)) = RTP - 1
//   化簡：M = (2 - RTP + P(踩柱)) / P(介於) - 1 = 1.04 / P(介於) - 1（代入 RTP=0.92, P(踩柱)=0.12）
//
// 兩種精細度都做、用常數開關切換（業主決定）：
//   TIER_11：gap 1~11 各自一個 M，最貼近真實機率，11 組數字
//   TIER_3 ：gap 分窄(1-3)/中(4-7)/寬(8-11) 三檔，M 由該檔內各 gap 的 P(介於) 平均值代入同公式算出
// 兩種模式的精確 RTP 由 dragon-gate Monte Carlo 模擬測試驗證（仿 slot M26）。

export const DRAGON_GATE_MIN_BET = 10;
export const DRAGON_GATE_MAX_BET = 1000; // 與 roulette 單注上限一致

export const DRAGON_GATE_TARGET_RTP = 0.92;
/** 踩柱機率恆定 6/50（與 gap 無關）：兩張門牌各剩 3 張 / 扣掉門牌後剩 50 張 */
export const DRAGON_GATE_DOOR_HIT_PROBABILITY = 6 / 50;

export type DragonGateOddsMode = 'TIER_3' | 'TIER_11';

/** 切換開關：改這個常數即可切換賠率精細度，不需要改任何邏輯 */
export const DRAGON_GATE_ODDS_MODE: DragonGateOddsMode = 'TIER_11';

/** gap（1~11）→ multiplier；M = 1.04 / (gap*0.08) - 1 = 13/gap - 1，四捨五入至小數點後 2 位 */
export const DRAGON_GATE_ODDS_TIER_11: Readonly<Record<number, number>> = {
  1: 12.0,
  2: 5.5,
  3: 3.33,
  4: 2.25,
  5: 1.6,
  6: 1.17,
  7: 0.86,
  8: 0.63,
  9: 0.44,
  10: 0.3,
  11: 0.18,
};

export type DragonGateTier3Bucket = 'NARROW' | 'MEDIUM' | 'WIDE';

/** gap 範圍 → 3 檔分桶（窄 1-3 / 中 4-7 / 寬 8-11） */
export const DRAGON_GATE_TIER_3_BUCKETS: ReadonlyArray<{
  bucket: DragonGateTier3Bucket;
  minGap: number;
  maxGap: number;
}> = [
  { bucket: 'NARROW', minGap: 1, maxGap: 3 },
  { bucket: 'MEDIUM', minGap: 4, maxGap: 7 },
  { bucket: 'WIDE', minGap: 8, maxGap: 11 },
];

/**
 * 各桶 multiplier。★易錯點★：不能用桶內各 gap 的 P(介於) 直接做「未加權平均」——
 * 兩張門牌的 rank 差距 d=|a-b| 對應的牌組數是 (13-d) 組（例如 d=2/gap=1 有 12 組，
 * d=12/gap=11 只有 1 組），所以小 gap 在隨機開門時出現的頻率遠高於大 gap，必須用
 * 「出現次數加權平均」P 再代入同一公式（用 Monte Carlo 模擬驗證過——未加權平均版本
 * 實測 RTP 只有 ~87.7%，偏離目標 92% 達 4 個百分點以上，已修正）：
 *   count(gap) = 12 - gap（gap=1~11）
 *   NARROW(1-3)：weighted P = 0.08*(11*1+10*2+9*3)/30 ≈ 0.15467 → M ≈ 5.72
 *   MEDIUM(4-7)：weighted P = 0.08*(8*4+7*5+6*6+5*7)/26 ≈ 0.42462 → M ≈ 1.45
 *   WIDE(8-11) ：weighted P = 0.08*(4*8+3*9+2*10+1*11)/10 = 0.72 → M ≈ 0.44
 */
export const DRAGON_GATE_ODDS_TIER_3: Readonly<Record<DragonGateTier3Bucket, number>> = {
  NARROW: 5.72,
  MEDIUM: 1.45,
  WIDE: 0.44,
};

// ═══════════════════════════ High-Low 猜高低 ═══════════════════════════
//
// 規則港自使用者自己的 pokergame/games/high_low.py（純邏輯，逐行對應）：
// 下注 → 開基準牌 → 猜高/低 → 猜對彩池×2（可收手或續押，連勝上限 5）→ 猜錯彩池歸零
// → 同點 push（不算輸，換新基準牌再猜）。基準牌是 A 時不可猜「高」、是 2 時不可猜
// 「低」——原版只在 UI 擋，這次移植時伺服器也必須驗證（防止繞過前端送出不可能的猜測）。
// 單一 52 張牌，剩 < 10 張時自動重洗（防止記牌必勝）。

export const HIGH_LOW_MIN_BET = 10;
export const HIGH_LOW_MAX_BET = 1000;
export const HIGH_LOW_MAX_STREAK = 5;
/** 牌堆剩餘張數低於此值時整副重新洗牌（pokergame _ensure_deck 同款邏輯） */
export const HIGH_LOW_DECK_RESHUFFLE_THRESHOLD = 10;

// ═══════════════════════════ Blackjack 二十一點 ═══════════════════════════
//
// 規則港自使用者自己的 pokergame/games/blackjack.py 上半部純函式（hand_value/
// is_blackjack/is_bust/dealer_should_hit/settle，逐行對應）：J/Q/K=10、A=11（爆牌時
// 逐張降為 1）；莊家 S17（含軟 17 一律停牌）；天生 Blackjack 賠 3:2；一般勝 1:1；
// 平手退注；Double Down 限前兩張、加倍後強制停牌；不做 Split（與原版一致，原版
// 註解也明寫「Split 留待第二版」）。
//
// 跟原版唯一的差異：原版是「剩 <20 張才重洗」的物理牌堆跨局延續；這裡改成
// ★每一局重新 CSPRNG 洗一副全新 4 副牌★（不延續上一局剩餘的牌)，徹底排除任何
// 算牌可能性，更符合本專案 server-authoritative 的精神。

export const BLACKJACK_MIN_BET = 10;
export const BLACKJACK_MAX_BET = 1000;
export const BLACKJACK_NUM_DECKS = 4;
/** false = S17（莊家軟 17 也停牌）；true = H17（軟 17 要補牌） */
export const BLACKJACK_DEALER_HITS_SOFT_17 = false;
/** 天生 Blackjack 賠率（3:2，注金 100 贏 150） */
export const BLACKJACK_NATURAL_PAYOUT_NUMERATOR = 3;
export const BLACKJACK_NATURAL_PAYOUT_DENOMINATOR = 2;

// ═══════════════════════════ 扭蛋機 Gacha ═══════════════════════════
//
// 護符獲取管道（01_GDD §3.3）：在 daily 任務 / gift code 之外，玩家可花 Coin
// 直接抽護符。依稀有度加權抽出一枚護符；由於 UserCharm @@unique([userId, charmId])
// 限制「一人一符」，抽到已擁有的護符時自動轉換為 Coin 回饋（重複轉換）。
//
// 全部數值集中本檔（authoritative）；前端透過 GET /api/gacha/catalog 取得展示用
// 機率/回饋，不另存一份於 packages/shared，避免雙寫漂移。

/** 護符稀有度由低到高（保底比較與權重索引用；對齊 prisma CharmRarity enum） */
export const CHARM_RARITY_ORDER = ['COMMON', 'RARE', 'EPIC', 'LEGENDARY'] as const;
export type CharmRarity = (typeof CHARM_RARITY_ORDER)[number];

/** 單抽價格（Coin） */
export const GACHA_SINGLE_COST = 500;
/** 十連抽次數 */
export const GACHA_TEN_PULL_COUNT = 10;
/** 十連抽價格（Coin）：9 折——付 9 抽的價格抽 10 次 */
export const GACHA_TEN_COST = GACHA_SINGLE_COST * (GACHA_TEN_PULL_COUNT - 1);

/**
 * 稀有度抽取權重（越大越常見）。實際機率 = weights[r] / Σ(池中存在的稀有度權重)，
 * 故顯示機率由 service 依「啟用護符實際涵蓋的稀有度」即時 renormalize。
 */
export const GACHA_RARITY_WEIGHTS: Readonly<Record<CharmRarity, number>> = {
  COMMON: 60,
  RARE: 28,
  EPIC: 10,
  LEGENDARY: 2,
};

/** 十連抽保底：保證十抽內至少一枚此稀有度（含）以上 */
export const GACHA_TEN_PULL_FLOOR: CharmRarity = 'RARE';

/** 重複護符轉換回饋（Coin）；依稀有度遞增——抽到重複不至於血本無歸 */
export const GACHA_DUPLICATE_REFUND: Readonly<Record<CharmRarity, number>> = {
  COMMON: 100,
  RARE: 250,
  EPIC: 450,
  LEGENDARY: 800,
};
