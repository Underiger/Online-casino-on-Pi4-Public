<template>
  <div class="roulette-view">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <header class="rv-header">
      <RouterLink class="back-btn" to="/casino" aria-label="返回大廳">
        ← 大廳
      </RouterLink>
      <span class="rv-title">歐式輪盤</span>
      <div class="rv-user">
        <CoinDisplay />
        <span class="rv-username">{{ authStore.user?.username ?? '' }}</span>
      </div>
    </header>

    <!-- ── Phase timer bar ────────────────────────────────────────────────── -->
    <div class="rv-phase-bar">
      <PhaseTimer
        :phase="rouletteStore.currentPhase"
        :phase-ends-at="rouletteStore.phaseEndsAt"
      />
      <span class="participant-count">{{ rouletteStore.participantCount }} 人同場</span>
    </div>

    <!-- ── Toast ──────────────────────────────────────────────────────────── -->
    <Transition name="toast">
      <div v-if="toastMsg !== null" class="rv-toast" :class="toastClass" role="alert">
        {{ toastMsg }}
      </div>
    </Transition>

    <!-- ── Main content ───────────────────────────────────────────────────── -->
    <main class="rv-main">

      <!-- Left column: wheel + result info -->
      <section class="wheel-col">
        <WheelCanvas ref="wheelRef" />

        <!-- Result display (RESULT / COOLDOWN) -->
        <Transition name="fade-up">
          <div
            v-if="showResult && rouletteStore.lastResult !== null"
            class="result-panel"
          >
            <div class="result-number" :class="rouletteStore.lastResult.color.toLowerCase()">
              {{ rouletteStore.lastResult.winningNumber }}
            </div>
            <div class="result-meta">
              <span class="result-color-label">{{ resultColorLabel }}</span>
              <span class="result-pool">獎池 {{ rouletteStore.lastResult.totalPool.toLocaleString() }} Coin</span>
            </div>
            <div
              v-if="rouletteStore.lastResult.personalPayout !== null"
              class="personal-payout"
              :class="rouletteStore.lastResult.personalPayout > 0 ? 'win' : 'lose'"
            >
              {{
                rouletteStore.lastResult.personalPayout > 0
                  ? `+${rouletteStore.lastResult.personalPayout.toLocaleString()} Coin 獲勝！`
                  : '本局未中獎'
              }}
            </div>
          </div>
        </Transition>

        <!-- Hot bets during COOLDOWN -->
        <Transition name="fade-up">
          <div
            v-if="rouletteStore.currentPhase === 'COOLDOWN' && rouletteStore.hotBets.length > 0"
            class="hot-bets"
          >
            <span class="hot-bets-label">本局熱門</span>
            <span
              v-for="hb in rouletteStore.hotBets.slice(0, 3)"
              :key="hb.type"
              class="hot-bet-chip"
            >
              {{ hb.type }}
              <em>×{{ hb.count }}</em>
            </span>
          </div>
        </Transition>
      </section>

      <!-- Right column: bet controls -->
      <section class="bet-col">

        <!-- Bet summary bar -->
        <div v-if="rouletteStore.totalBet > 0 || rouletteStore.personalBets.length > 0" class="bet-summary">
          <div class="bet-summary-row">
            <span>本局下注</span>
            <strong class="coin-text">{{ rouletteStore.totalBet.toLocaleString() }} C</strong>
          </div>
          <div class="bet-summary-row">
            <span>剩餘額度</span>
            <strong :class="rouletteStore.remaining < 200 ? 'warn-text' : 'coin-text'">
              {{ rouletteStore.remaining.toLocaleString() }} C
            </strong>
          </div>
        </div>

        <!-- Chip selector -->
        <ChipSelector v-model="selectedChip" class="chip-area" />

        <!-- Bet board -->
        <BetBoard
          :chip-amount="selectedChip"
          :bet-amount-by-type="rouletteStore.betAmountByType"
          :phase="rouletteStore.currentPhase"
          @place-bet="handlePlaceBet"
          @cancel-bets="handleCancelBets"
        />
      </section>

    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { useRouletteStore } from '../stores/roulette';
import { useAuthStore } from '../stores/auth';
import WheelCanvas from '../components/roulette/WheelCanvas.vue';
import BetBoard from '../components/roulette/BetBoard.vue';
import ChipSelector from '../components/roulette/ChipSelector.vue';
import PhaseTimer from '../components/roulette/PhaseTimer.vue';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import type { PersonalBet } from '../stores/roulette';

// ─── Stores ───────────────────────────────────────────────────────────────

const rouletteStore = useRouletteStore();
const authStore = useAuthStore();

// ─── Refs ─────────────────────────────────────────────────────────────────

const wheelRef = ref<InstanceType<typeof WheelCanvas> | null>(null);
const selectedChip = ref(50);

// ─── Toast ────────────────────────────────────────────────────────────────

const toastMsg = ref<string | null>(null);
const toastClass = ref<'toast-error' | 'toast-ok' | ''>('');
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(msg: string, cls: 'toast-error' | 'toast-ok' = 'toast-ok'): void {
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastMsg.value = msg;
  toastClass.value = cls;
  toastTimer = setTimeout(() => { toastMsg.value = null; }, 3200);
}

// ─── Error code → Chinese message ────────────────────────────────────────

const ERROR_MSGS: Record<string, string> = {
  ROULETTE_PHASE_CLOSED: '下注時間已過，請等待下一局',
  BET_LIMIT_EXCEEDED:    '下注金額超過限制',
  INSUFFICIENT_BALANCE:  '餘額不足，無法下注',
  VALIDATION_ERROR:      '下注資料格式錯誤',
  INTERNAL_ERROR:        '伺服器錯誤，請稍後再試',
  HMAC_KEY_MISSING:      '登入驗證失效，請重新登入',
  BET_IN_FLIGHT:         '請稍候，上筆下注仍在處理中',
  TIMEOUT:               '請求逾時，請重試',
  BET_REJECTED:          '下注被拒絕',
};

function toMsg(code: string): string {
  return ERROR_MSGS[code] ?? `錯誤：${code}`;
}

// ─── Bet handlers ─────────────────────────────────────────────────────────

async function handlePlaceBet(bet: Omit<PersonalBet, '_id'>): Promise<void> {
  const err = await rouletteStore.placeBet(bet);
  if (err !== null) showToast(toMsg(err), 'toast-error');
}

async function handleCancelBets(): Promise<void> {
  const err = await rouletteStore.cancelBets();
  if (err !== null) {
    showToast(toMsg(err), 'toast-error');
  } else {
    showToast('已取消本局下注', 'toast-ok');
  }
}

// ─── Computed helpers ─────────────────────────────────────────────────────

const showResult = computed(() =>
  rouletteStore.currentPhase === 'RESULT' ||
  rouletteStore.currentPhase === 'COOLDOWN',
);

const resultColorLabel = computed((): string => {
  const c = rouletteStore.lastResult?.color;
  if (c === 'RED')   return '紅';
  if (c === 'BLACK') return '黑';
  if (c === 'GREEN') return '綠（0）';
  return '';
});

// ─── Wheel highlight on new result ────────────────────────────────────────

watch(
  () => rouletteStore.lastResult?.roundId,
  () => {
    const r = rouletteStore.lastResult;
    if (r === null || r === undefined) return;
    void nextTick(() => {
      wheelRef.value?.highlightNumber(r.winningNumber);
    });
  },
);

// ─── Payout toast when RESULT arrives ────────────────────────────────────

watch(
  () => rouletteStore.lastResult,
  (result) => {
    if (result === null) return;
    if (result.personalPayout !== null && result.personalPayout > 0) {
      showToast(`中獎！獲得 ${result.personalPayout.toLocaleString()} Coin`, 'toast-ok');
    }
  },
);

// ─── Lifecycle ────────────────────────────────────────────────────────────

onMounted(async () => {
  rouletteStore.connectSocket();
  await rouletteStore.fetchInitialState();
});

onUnmounted(() => {
  rouletteStore.disconnectSocket();
  if (toastTimer !== null) clearTimeout(toastTimer);
});
</script>

<style scoped>
/* ── Root ──────────────────────────────────────────────────────────────── */
.roulette-view {
  min-height: 100vh;
  background: linear-gradient(160deg, #0f0c29 0%, #302b63 50%, #24243e 100%);
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
}

/* ── Header ────────────────────────────────────────────────────────────── */
.rv-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: rgba(0, 0, 0, 0.35);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  position: sticky;
  top: 0;
  z-index: 10;
}

.back-btn {
  color: #94a3b8;
  text-decoration: none;
  font-size: 0.85rem;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.15s;
}
.back-btn:hover { color: #e2e8f0; }

.rv-title {
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #fbbf24;
}

.rv-user {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rv-username {
  font-size: 0.8rem;
  color: #94a3b8;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Phase bar ─────────────────────────────────────────────────────────── */
.rv-phase-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  background: rgba(0, 0, 0, 0.25);
}

.rv-phase-bar > :first-child {
  flex: 1;
}

.participant-count {
  font-size: 0.75rem;
  color: #64748b;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Toast ─────────────────────────────────────────────────────────────── */
.rv-toast {
  position: fixed;
  top: 72px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 100;
  padding: 10px 20px;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  max-width: 90vw;
  text-align: center;
  pointer-events: none;
}

.toast-ok    { background: rgba(21, 128, 61, 0.92); color: #d1fae5; }
.toast-error { background: rgba(185, 28, 28, 0.92); color: #fee2e2; }

.toast-enter-active,
.toast-leave-active { transition: all 0.3s ease; }
.toast-enter-from,
.toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(-12px); }

/* ── Main layout ───────────────────────────────────────────────────────── */
.rv-main {
  flex: 1;
  display: flex;
  gap: 16px;
  padding: 16px;
  max-width: 960px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
}

/* Two-column on desktop */
@media (min-width: 640px) {
  .wheel-col {
    flex: 0 0 auto;
    width: min(45%, 380px);
  }
  .bet-col {
    flex: 1;
    min-width: 0;
  }
}

/* Stacked on mobile */
@media (max-width: 639px) {
  .rv-main {
    flex-direction: column;
    padding: 10px;
    gap: 12px;
  }
  .wheel-col {
    width: 100%;
  }
}

/* ── Wheel column ──────────────────────────────────────────────────────── */
.wheel-col {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

/* ── Result panel ──────────────────────────────────────────────────────── */
.result-panel {
  text-align: center;
}

.result-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  border-radius: 50%;
  font-size: 1.8rem;
  font-weight: 900;
  border: 3px solid #fbbf24;
  margin: 0 auto 6px;
}

.result-number.red   { background: #b91c1c; color: #fff; }
.result-number.black { background: #1c1917; color: #fff; }
.result-number.green { background: #15803d; color: #fff; }

.result-meta {
  display: flex;
  justify-content: center;
  gap: 12px;
  font-size: 0.8rem;
  color: #94a3b8;
  margin-bottom: 6px;
}

.result-color-label {
  font-weight: 700;
  color: #e2e8f0;
}

.personal-payout {
  font-size: 0.95rem;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: 6px;
  display: inline-block;
}

.personal-payout.win  { background: rgba(21, 128, 61, 0.25); color: #86efac; }
.personal-payout.lose { background: rgba(100, 116, 139, 0.2); color: #94a3b8; }

/* ── Hot bets ──────────────────────────────────────────────────────────── */
.hot-bets {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: center;
}

.hot-bets-label {
  font-size: 0.72rem;
  color: #64748b;
}

.hot-bet-chip {
  font-size: 0.72rem;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(251, 191, 36, 0.15);
  color: #fbbf24;
}

.hot-bet-chip em {
  font-style: normal;
  color: #94a3b8;
  margin-left: 2px;
}

/* ── Bet column ────────────────────────────────────────────────────────── */
.bet-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── Bet summary ──────────────────────────────────────────────────────── */
.bet-summary {
  display: flex;
  gap: 16px;
  padding: 8px 12px;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.07);
}

.bet-summary-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 0.75rem;
}

.bet-summary-row span {
  color: #64748b;
}

.coin-text { color: #fbbf24; font-size: 0.9rem; }
.warn-text { color: #f87171; font-size: 0.9rem; }

/* ── Chip area ─────────────────────────────────────────────────────────── */
.chip-area {
  align-self: center;
}

/* ── Transitions ───────────────────────────────────────────────────────── */
.fade-up-enter-active,
.fade-up-leave-active { transition: all 0.4s ease; }
.fade-up-enter-from,
.fade-up-leave-to { opacity: 0; transform: translateY(10px); }
</style>
