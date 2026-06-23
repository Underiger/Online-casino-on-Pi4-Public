<script setup lang="ts">
/**
 * GachaView：護符扭蛋機。
 * 玩家花 Coin 抽護符——單抽 / 十連（十連保底 ≥1 張 RARE+）。
 * 抽到已擁有的護符自動轉換為 Coin 回饋（一人一符）。
 * 下方為收集圖鑑（已擁有 vs 未擁有）與抽取機率。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useWalletStore } from '../stores/wallet';
import { useGachaStore } from '../stores/gacha';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import type { GachaDraw } from '@casino/shared';

const router = useRouter();
const auth = useAuthStore();
const wallet = useWalletStore();
const gacha = useGachaStore();

const lastResults = ref<GachaDraw[] | null>(null);
const showResults = ref(false);
const shaking = ref(false);
const toast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// ── 稀有度 / 類型展示對照（沿用 CharmSlotBar 視覺語言）──
const RARITY_CLASS: Record<string, string> = {
  COMMON: 'rarity-common',
  RARE: 'rarity-rare',
  EPIC: 'rarity-epic',
  LEGENDARY: 'rarity-legendary',
};
const RARITY_LABEL: Record<string, string> = {
  COMMON: '普通',
  RARE: '稀有',
  EPIC: '史詩',
  LEGENDARY: '傳說',
};
const TYPE_ICON: Record<string, string> = {
  WEIGHT: '⚖️',
  RULE: '📜',
  CONDITIONAL: '🎲',
  PITY: '🛡',
  BONUS: '💎',
};

function rarityClass(r: string): string {
  return RARITY_CLASS[r] ?? 'rarity-common';
}
function rarityLabel(r: string): string {
  return RARITY_LABEL[r] ?? r;
}
function typeIcon(t: string): string {
  return TYPE_ICON[t] ?? '🔮';
}

const singleCost = computed(() => gacha.catalog?.singleCost ?? null);
const tenCost = computed(() => gacha.catalog?.tenCost ?? null);
const floorLabel = computed(() =>
  gacha.catalog ? rarityLabel(gacha.catalog.floorRarity) : '稀有',
);

const balance = computed<bigint>(() => {
  try {
    return wallet.balance !== null ? BigInt(wallet.balance) : 0n;
  } catch {
    return 0n;
  }
});

const canSingle = computed(
  () => singleCost.value !== null && balance.value >= BigInt(singleCost.value),
);
const canTen = computed(
  () => tenCost.value !== null && balance.value >= BigInt(tenCost.value),
);

function formatCoin(n: number | string): string {
  try {
    return Number(BigInt(n)).toLocaleString();
  } catch {
    return String(n);
  }
}

function showToast(msg: string): void {
  toast.value = msg;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, 3500);
}

async function doPull(count: 1 | 10): Promise<void> {
  if (gacha.pulling || shaking.value) return;
  shaking.value = true;
  const res = await gacha.pull(count);
  // 讓搖晃動畫至少跑一段時間再揭曉
  await new Promise((r) => setTimeout(r, 650));
  shaking.value = false;

  if (res === null) {
    showToast(gacha.error ?? '抽取失敗，請稍後再試');
    return;
  }
  lastResults.value = res.results;
  showResults.value = true;
}

function closeResults(): void {
  showResults.value = false;
}

// 結果統計（新護符 / 重複回饋）
const resultSummary = computed(() => {
  const list = lastResults.value ?? [];
  const newCount = list.filter((r) => r.isNew).length;
  const refund = list.reduce((sum, r) => sum + Number(r.refund), 0);
  return { newCount, refund, total: list.length };
});

onMounted(() => {
  void wallet.fetchBalance();
  void gacha.fetchCatalog();
});

onUnmounted(() => {
  if (toastTimer !== null) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="gacha">
    <!-- Header -->
    <header class="header">
      <button class="back-btn" @click="router.replace('/casino')">← 大廳</button>
      <div class="brand">🥚 護符扭蛋機</div>
      <div class="header-right">
        <CoinDisplay />
        <span class="username">{{ auth.user?.username }}</span>
      </div>
    </header>

    <!-- Toast -->
    <Transition name="toast-fade">
      <div v-if="toast !== null" class="toast" role="alert">{{ toast }}</div>
    </Transition>

    <main class="main">
      <!-- 扭蛋機本體 -->
      <section class="machine-area">
        <div class="machine" :class="{ shaking }" aria-hidden="true">
          <div class="machine-top">
            <div class="capsule c1"></div>
            <div class="capsule c2"></div>
            <div class="capsule c3"></div>
            <div class="capsule c4"></div>
            <div class="capsule c5"></div>
          </div>
          <div class="machine-body">
            <span class="machine-emoji">✨</span>
          </div>
          <div class="machine-slot"></div>
        </div>

        <div class="collection-line" v-if="gacha.catalog">
          護符圖鑑：<strong>{{ gacha.catalog.ownedCount }}</strong> / {{ gacha.catalog.totalCount }} 收集
        </div>

        <div class="pull-buttons">
          <button
            class="pull-btn single"
            :disabled="gacha.pulling || shaking || !canSingle || singleCost === null"
            @click="doPull(1)"
          >
            <span class="pull-title">單抽</span>
            <span class="pull-cost">💰 {{ singleCost !== null ? formatCoin(singleCost) : '—' }}</span>
          </button>
          <button
            class="pull-btn ten"
            :disabled="gacha.pulling || shaking || !canTen || tenCost === null"
            @click="doPull(10)"
          >
            <span class="pull-title">十連抽</span>
            <span class="pull-cost">💰 {{ tenCost !== null ? formatCoin(tenCost) : '—' }}</span>
            <span class="pull-badge">保底 {{ floorLabel }}+</span>
          </button>
        </div>
        <p v-if="(!canSingle || !canTen) && gacha.catalog" class="hint-low">
          餘額不足以進行部分抽取
        </p>
        <p class="hint">
          重複護符會自動轉換為 Coin 回饋（一人一符）。抽到的護符可在
          <RouterLink to="/slot" class="inline-link">老虎機</RouterLink> 頁面裝備。
        </p>
      </section>

      <!-- 抽取機率 -->
      <section v-if="gacha.catalog" class="section">
        <h3 class="section-title">抽取機率 / 重複回饋</h3>
        <div class="rates-grid">
          <div
            v-for="r in gacha.catalog.rarities"
            :key="r.rarity"
            class="rate-card"
            :class="rarityClass(r.rarity)"
          >
            <span class="rate-rarity">{{ rarityLabel(r.rarity) }}</span>
            <span class="rate-pct">{{ r.rate }}%</span>
            <span class="rate-refund">重複 +{{ formatCoin(r.dupRefund) }}</span>
          </div>
        </div>
      </section>

      <!-- 收集圖鑑 -->
      <section v-if="gacha.catalog" class="section">
        <h3 class="section-title">護符圖鑑</h3>
        <div v-if="gacha.loading && gacha.catalog === null" class="empty">載入中…</div>
        <div class="pool-grid">
          <div
            v-for="item in gacha.catalog.pool"
            :key="item.id"
            class="pool-card"
            :class="[rarityClass(item.rarity), { locked: !item.owned }]"
            :title="item.description"
          >
            <span class="pool-icon">{{ item.owned ? typeIcon(item.type) : '❔' }}</span>
            <span class="pool-name">{{ item.owned ? item.name : '未收集' }}</span>
            <span class="pool-rarity">{{ rarityLabel(item.rarity) }}</span>
            <span v-if="item.owned" class="owned-tick">✓</span>
          </div>
        </div>
      </section>
    </main>

    <!-- 抽取結果 overlay -->
    <Transition name="modal-fade">
      <div v-if="showResults" class="overlay" @click.self="closeResults">
        <div class="result-modal" role="dialog" aria-label="抽取結果">
          <div class="result-head">
            <span class="result-title">✨ 抽取結果</span>
            <button class="result-close" aria-label="關閉" @click="closeResults">✕</button>
          </div>

          <div class="result-summary">
            <span>共 {{ resultSummary.total }} 抽</span>
            <span class="sep">·</span>
            <span class="new-tag">新 {{ resultSummary.newCount }}</span>
            <template v-if="resultSummary.refund > 0">
              <span class="sep">·</span>
              <span class="refund-tag">重複回饋 +{{ formatCoin(resultSummary.refund) }} Coin</span>
            </template>
          </div>

          <div class="result-grid" :class="{ single: (lastResults?.length ?? 0) === 1 }">
            <div
              v-for="(draw, i) in lastResults ?? []"
              :key="i"
              class="draw-card"
              :class="rarityClass(draw.rarity)"
            >
              <span v-if="draw.isNew" class="new-badge">NEW</span>
              <span v-else class="dup-badge">+{{ formatCoin(draw.refund) }}</span>
              <span class="draw-icon">{{ typeIcon(draw.type) }}</span>
              <span class="draw-name">{{ draw.name }}</span>
              <span class="draw-rarity">{{ rarityLabel(draw.rarity) }}</span>
            </div>
          </div>

          <button class="result-again" :disabled="gacha.pulling" @click="closeResults">
            繼續
          </button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.gacha {
  min-height: 100dvh;
  background: linear-gradient(160deg, #0d0d1a 0%, #1a1a2e 60%, #16213e 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
}

/* Header */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.8rem 1.5rem;
  background: rgba(0, 0, 0, 0.4);
  border-bottom: 1px solid rgba(255, 215, 0, 0.2);
  position: sticky;
  top: 0;
  z-index: 100;
  gap: 1rem;
}
.back-btn {
  padding: 0.35rem 0.85rem;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.back-btn:hover { border-color: #ffd700; color: #ffd700; }
.brand { font-size: 1.1rem; font-weight: 700; color: #ffd700; }
.header-right { display: flex; align-items: center; gap: 1rem; }
.username { color: rgba(255, 255, 255, 0.8); font-size: 0.9rem; }

/* Toast */
.toast {
  position: fixed;
  top: 4.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(255, 215, 0, 0.92);
  color: #000;
  padding: 0.6rem 1.4rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  z-index: 999;
  white-space: nowrap;
  max-width: 90vw;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.toast-fade-enter-active, .toast-fade-leave-active { transition: opacity 0.3s; }
.toast-fade-enter-from, .toast-fade-leave-to { opacity: 0; }

/* Main */
.main {
  flex: 1;
  max-width: 880px;
  width: 100%;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}
.empty { color: rgba(255, 255, 255, 0.4); font-size: 0.9rem; text-align: center; padding: 1rem 0; }

/* 扭蛋機 */
.machine-area {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding-top: 1rem;
}
.machine {
  width: 180px;
  display: flex;
  flex-direction: column;
  align-items: center;
  transform-origin: bottom center;
}
.machine.shaking { animation: shake 0.45s ease-in-out infinite; }
@keyframes shake {
  0%, 100% { transform: rotate(0deg); }
  25% { transform: rotate(-4deg); }
  75% { transform: rotate(4deg); }
}
.machine-top {
  width: 150px;
  height: 130px;
  border-radius: 50% 50% 14px 14px;
  background: radial-gradient(circle at 40% 30%, rgba(255, 255, 255, 0.18), rgba(255, 255, 255, 0.05));
  border: 3px solid rgba(255, 215, 0, 0.5);
  position: relative;
  overflow: hidden;
  display: flex;
  flex-wrap: wrap;
  align-content: center;
  justify-content: center;
  gap: 6px;
  padding: 14px;
  box-sizing: border-box;
}
.capsule { width: 26px; height: 26px; border-radius: 50%; }
.c1 { background: #ff6b6b; }
.c2 { background: #4ecdc4; }
.c3 { background: #ffd93d; }
.c4 { background: #a78bfa; }
.c5 { background: #6ee7b7; }
.machine-body {
  width: 120px;
  height: 60px;
  background: linear-gradient(180deg, rgba(255, 215, 0, 0.85), rgba(255, 140, 0, 0.85));
  border-radius: 0 0 10px 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: -2px;
}
.machine-emoji { font-size: 1.8rem; }
.machine-slot {
  width: 50px;
  height: 12px;
  background: #0d0d1a;
  border-radius: 0 0 6px 6px;
  margin-top: 2px;
}
.collection-line { font-size: 0.9rem; color: rgba(255, 255, 255, 0.75); }
.collection-line strong { color: #ffd700; }

.pull-buttons { display: flex; gap: 1rem; flex-wrap: wrap; justify-content: center; }
.pull-btn {
  position: relative;
  min-width: 130px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.9rem 1.4rem;
  border-radius: 12px;
  border: 1px solid rgba(255, 215, 0, 0.4);
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  cursor: pointer;
  transition: all 0.2s;
}
.pull-btn:hover:not(:disabled) {
  border-color: #ffd700;
  background: rgba(255, 215, 0, 0.12);
  transform: translateY(-2px);
}
.pull-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pull-btn.ten { border-color: rgba(167, 103, 243, 0.6); }
.pull-btn.ten:hover:not(:disabled) { border-color: #c4b5fd; background: rgba(167, 103, 243, 0.15); }
.pull-title { font-size: 1.05rem; font-weight: 700; }
.pull-cost { font-size: 0.85rem; color: #ffd700; }
.pull-badge {
  position: absolute;
  top: -10px;
  right: -8px;
  font-size: 0.6rem;
  padding: 2px 7px;
  border-radius: 8px;
  background: #a78bfa;
  color: #1a1a2e;
  font-weight: 700;
}
.hint-low { font-size: 0.78rem; color: #ff9b9b; margin: 0; }
.hint { font-size: 0.8rem; color: rgba(255, 255, 255, 0.5); text-align: center; margin: 0; max-width: 460px; }
.inline-link { color: #ffd700; }

/* Sections */
.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  margin: 0 0 0.9rem;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

/* 機率 */
.rates-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 0.7rem; }
.rate-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  padding: 0.7rem;
  border-radius: 10px;
  border: 1px solid;
  background: rgba(255, 255, 255, 0.03);
}
.rate-rarity { font-size: 0.8rem; font-weight: 600; }
.rate-pct { font-size: 1.2rem; font-weight: 700; }
.rate-refund { font-size: 0.68rem; color: rgba(255, 255, 255, 0.55); }

/* 圖鑑 */
.pool-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 0.7rem; }
.pool-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 0.8rem 0.5rem;
  border-radius: 10px;
  border: 1px solid;
  background: rgba(255, 255, 255, 0.04);
  text-align: center;
}
.pool-card.locked { opacity: 0.45; filter: grayscale(0.8); }
.pool-icon { font-size: 1.6rem; }
.pool-name {
  font-size: 0.78rem;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pool-rarity { font-size: 0.62rem; opacity: 0.7; }
.owned-tick {
  position: absolute;
  top: 5px;
  right: 6px;
  font-size: 0.7rem;
  color: #6ee7b7;
  font-weight: 700;
}

/* 稀有度配色（沿用 CharmSlotBar）*/
.rarity-common  { border-color: rgba(160, 160, 160, 0.6); color: rgba(255,255,255,0.82); }
.rarity-rare    { border-color: rgba(59, 130, 246, 0.7);  color: #93c5fd; }
.rarity-epic    { border-color: rgba(167, 103, 243, 0.8); color: #c4b5fd; }
.rarity-legendary { border-color: rgba(255, 215, 0, 0.9); color: #ffd700; }

/* 結果 overlay */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
  padding: 1rem;
}
.result-modal {
  width: 100%;
  max-width: 560px;
  max-height: 86vh;
  overflow-y: auto;
  background: #1a1a2e;
  border: 1px solid rgba(255, 215, 0, 0.3);
  border-radius: 16px;
  padding: 1.2rem;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6);
}
.result-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem; }
.result-title { font-size: 1.1rem; font-weight: 700; color: #ffd700; }
.result-close { background: none; border: none; color: rgba(255,255,255,0.5); font-size: 1rem; cursor: pointer; }
.result-close:hover { color: #fff; }
.result-summary { font-size: 0.85rem; color: rgba(255,255,255,0.7); margin-bottom: 1rem; }
.result-summary .sep { margin: 0 0.4rem; opacity: 0.4; }
.new-tag { color: #6ee7b7; font-weight: 600; }
.refund-tag { color: #ffd700; font-weight: 600; }

.result-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0.6rem; }
.result-grid.single { grid-template-columns: 1fr; justify-items: center; }
.result-grid.single .draw-card { width: 140px; padding: 1.2rem 0.6rem; }
.draw-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  padding: 0.7rem 0.4rem;
  border-radius: 10px;
  border: 1px solid;
  background: rgba(255, 255, 255, 0.05);
  animation: pop 0.35s ease;
}
@keyframes pop {
  0% { transform: scale(0.6); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}
.draw-icon { font-size: 1.5rem; }
.draw-name { font-size: 0.7rem; text-align: center; line-height: 1.2; }
.draw-rarity { font-size: 0.6rem; opacity: 0.75; }
.new-badge {
  position: absolute;
  top: -7px;
  left: -6px;
  font-size: 0.55rem;
  font-weight: 800;
  padding: 1px 5px;
  border-radius: 6px;
  background: #6ee7b7;
  color: #0d0d1a;
}
.dup-badge {
  position: absolute;
  top: -7px;
  right: -6px;
  font-size: 0.58rem;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 6px;
  background: rgba(255, 215, 0, 0.85);
  color: #0d0d1a;
}
.result-again {
  display: block;
  width: 100%;
  margin-top: 1.2rem;
  padding: 0.7rem;
  border-radius: 10px;
  border: none;
  background: linear-gradient(135deg, #ffd700, #ff8c00);
  color: #1a1a2e;
  font-weight: 700;
  font-size: 0.95rem;
  cursor: pointer;
}
.result-again:disabled { opacity: 0.5; cursor: not-allowed; }

.modal-fade-enter-active, .modal-fade-leave-active { transition: opacity 0.25s; }
.modal-fade-enter-from, .modal-fade-leave-to { opacity: 0; }

@media (max-width: 480px) {
  .result-grid { grid-template-columns: repeat(3, 1fr); }
}
</style>
