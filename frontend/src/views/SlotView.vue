<script setup lang="ts">
/**
 * SlotView（M12）：老虎機主頁面。
 * 三軸滾輪 + 注額選擇 + 旋轉按鈕 + 賠率表 + 保底指示器 + 護符槽佔位。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { SlotSymbol } from '@casino/shared';
import { SLOT_BET_AMOUNTS } from '@casino/shared';
import type { SlotBetAmount, SpinRes } from '@casino/shared';
import type { JackpotTickPayload, JackpotWonPayload } from '@casino/shared';
import { SOCKET_EVENTS } from '@casino/shared';

import { useSlotStore } from '../stores/slot';
import { useWalletStore } from '../stores/wallet';
import { useAuthStore } from '../stores/auth';
import { useCharmStore } from '../stores/charm';
import { getSocket } from '../socket/client';

import CoinDisplay from '../components/common/CoinDisplay.vue';
import ReelColumn from '../components/slot/ReelColumn.vue';
import CharmSlotBar from '../components/slot/CharmSlotBar.vue';
import PaytableModal from '../components/slot/PaytableModal.vue';
import PityIndicator from '../components/slot/PityIndicator.vue';

const slotStore = useSlotStore();
const wallet = useWalletStore();
const auth = useAuthStore();
const charmStore = useCharmStore();

// ── 旋轉動畫狀態（view-local，獨立於 store.isSpinning）──
const isAnimating = ref(false);
const reelSpinning = ref<[boolean, boolean, boolean]>([false, false, false]);
const finalSymbols = ref<[SlotSymbol, SlotSymbol, SlotSymbol]>([
  SlotSymbol.CHERRY,
  SlotSymbol.CHERRY,
  SlotSymbol.CHERRY,
]);
const stoppedCount = ref(0);
const lastWin = ref(0);
const showWinOverlay = ref(false);
const pendingResult = ref<SpinRes | null>(null);

// ── UI 狀態 ──
const showPaytable = ref(false);
const toast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

// ── Jackpot 即時金額（Socket 驅動）──
const jackpotPool = computed(() => slotStore.jackpotPool);

// ── 按鈕禁用條件 ──
const spinDisabled = computed(() => isAnimating.value || slotStore.isSpinning);

// ── 拉桿動畫 ──
const leverDown = ref(false);

// ── BGM（M12 追加）：瀏覽器政策需使用者互動後才能有聲播放 ──
const bgmAudio = ref<HTMLAudioElement | null>(null);
const bgmMuted = ref(localStorage.getItem('slot-bgm-muted') === 'true');

function toggleBgmMuted(): void {
  bgmMuted.value = !bgmMuted.value;
  localStorage.setItem('slot-bgm-muted', String(bgmMuted.value));
  const audio = bgmAudio.value;
  if (audio === null) return;
  if (bgmMuted.value) {
    audio.pause();
  } else {
    void audio.play().catch(() => { /* 使用者尚未互動，待下次操作觸發 */ });
  }
}

async function handleLeverPull(): Promise<void> {
  if (spinDisabled.value) return;
  if (bgmAudio.value !== null && bgmAudio.value.paused && !bgmMuted.value) {
    void bgmAudio.value.play().catch(() => { /* 忽略瀏覽器自動播放限制 */ });
  }
  leverDown.value = true;
  await new Promise<void>(r => setTimeout(r, 280));
  leverDown.value = false;
  await handleSpin();
}

// ── 格式化 ──
function formatCoin(val: string | null): string {
  if (val === null) return '—';
  try { return Number(BigInt(val)).toLocaleString() + ' Coin'; } catch { return val; }
}

function showToast(msg: string, durationMs = 3500): void {
  if (toastTimer !== null) clearTimeout(toastTimer);
  toast.value = msg;
  toastTimer = setTimeout(() => { toast.value = null; }, durationMs);
}

// ── 旋轉主流程 ──
async function handleSpin(): Promise<void> {
  if (spinDisabled.value) return;

  const amount = slotStore.betAmount;

  isAnimating.value = true;
  reelSpinning.value = [true, true, true];
  stoppedCount.value = 0;
  lastWin.value = 0;
  showWinOverlay.value = false;
  pendingResult.value = null;
  slotStore.clearError();

  const spinStart = Date.now();

  const result = await slotStore.spin(amount);

  if (result === null) {
    // API 失敗：停止動畫並顯示錯誤
    reelSpinning.value = [false, false, false];
    isAnimating.value = false;
    if (slotStore.error !== null) {
      showToast(slotStore.error);
    }
    return;
  }

  pendingResult.value = result;
  finalSymbols.value = result.reels;

  // 確保動畫至少跑 1600ms（API 回應可能極快）
  const elapsed = Date.now() - spinStart;
  const minWait = Math.max(0, 1600 - elapsed);
  await new Promise<void>(resolve => setTimeout(resolve, minWait));

  // 逐軸停止（間隔 420ms，形成連鎖視覺效果）
  reelSpinning.value[0] = false;
  await new Promise<void>(resolve => setTimeout(resolve, 420));
  reelSpinning.value[1] = false;
  await new Promise<void>(resolve => setTimeout(resolve, 420));
  reelSpinning.value[2] = false;
}

function onReelSpinEnd(): void {
  stoppedCount.value++;
  if (stoppedCount.value < 3) return;

  // 三軸全停 → 顯示結果
  stoppedCount.value = 0;
  isAnimating.value = false;

  if (pendingResult.value !== null) {
    const r = pendingResult.value;
    lastWin.value = r.payout;

    if (r.payout > 0) {
      showWinOverlay.value = true;
      setTimeout(() => { showWinOverlay.value = false; }, 2200);
    }

    if (r.pityActive) {
      showToast('🎯 保底生效！賠率 ×1.5', 2800);
    }

    if (r.jackpotTriggered) {
      // M14：派彩成功時顯示金額（jackpot:won 廣播另含全服通知）
      if (r.jackpotPayout !== null) {
        showToast(`🏆 JACKPOT！你贏得 ${formatAmount(r.jackpotPayout)} Coin！`, 6000);
      } else {
        showToast('🏆 恭喜！Jackpot 觸發！', 5000);
      }
    }
  }
}

function formatAmount(val: string): string {
  try { return Number(BigInt(val)).toLocaleString(); } catch { return val; }
}

function selectBet(amount: SlotBetAmount): void {
  if (isAnimating.value) return;
  slotStore.setBetAmount(amount);
}

// ── Socket：訂閱 Jackpot 即時金額 + 中獎廣播（M14） ──
onMounted(async () => {
  await wallet.fetchBalance();
  void charmStore.fetchInventory();

  const socket = getSocket();
  socket.on(SOCKET_EVENTS.JACKPOT_TICK, (payload: JackpotTickPayload) => {
    slotStore.setJackpotPool(payload.pool);
  });
  socket.on(SOCKET_EVENTS.JACKPOT_WON, (payload: JackpotWonPayload) => {
    // 即時更新 Ticker：派彩後獎池 = poolBefore − payout（20% 留底）
    try {
      slotStore.setJackpotPool(
        (BigInt(payload.poolBefore) - BigInt(payload.payout)).toString(),
      );
    } catch { /* payload 異常時等下一次 jackpot:tick 校正 */ }

    if (payload.userId === auth.user?.id) {
      // 自己中獎：spin 回應已顯示 JACKPOT toast，這裡不重複打擾
      return;
    }
    showToast(`🏆 ${payload.username} 贏得全服 Jackpot ${formatAmount(payload.payout)} Coin！`, 5000);
  });
});

onUnmounted(() => {
  if (toastTimer !== null) clearTimeout(toastTimer);
  const socket = getSocket();
  socket.off(SOCKET_EVENTS.JACKPOT_TICK);
  socket.off(SOCKET_EVENTS.JACKPOT_WON);
  bgmAudio.value?.pause();
});
</script>

<template>
  <div class="slot-view">
    <!-- ─── Header ─────────────────────────────────────── -->
    <header class="header">
      <RouterLink to="/casino" class="back-btn" aria-label="返回大廳">← 大廳</RouterLink>
      <span class="page-title">🎰 老虎機</span>
      <div class="header-right">
        <button
          class="bgm-toggle-btn"
          :aria-label="bgmMuted ? '開啟音樂' : '關閉音樂'"
          :aria-pressed="!bgmMuted"
          @click="toggleBgmMuted"
        >
          {{ bgmMuted ? '🔇' : '🔊' }}
        </button>
        <CoinDisplay />
        <span class="username">{{ auth.user?.username }}</span>
      </div>
    </header>

    <audio ref="bgmAudio" src="/audio/triple-seven-spin.mp3" loop preload="auto" />


    <!-- ─── Jackpot Ticker ─────────────────────────────── -->
    <div class="jackpot-ticker">
      <span class="jackpot-label">🏆 Jackpot</span>
      <span class="jackpot-amount">{{ formatCoin(jackpotPool) }}</span>
    </div>

    <!-- ─── Toast 通知 ──────────────────────────────────── -->
    <Transition name="toast">
      <div v-if="toast !== null" class="toast" role="alert">{{ toast }}</div>
    </Transition>

    <main class="main">
      <!-- ─── 機台 + 滾輪 ──────────────────────────────────── -->
      <section class="machine-wrapper" aria-label="老虎機">
        <img
          class="machine-cabinet"
          :src="leverDown ? '/symbols/slot-down.png' : '/symbols/slot-up.png'"
          alt=""
          draggable="false"
        />

        <!-- 滾輪嵌入機台視窗 -->
        <div class="reels-inner">
          <Transition name="win">
            <div v-if="showWinOverlay" class="win-overlay">
              <span class="win-label">WIN!</span>
              <span class="win-amount">+{{ lastWin.toLocaleString() }}</span>
              <span class="win-unit">Coin</span>
            </div>
          </Transition>
          <ReelColumn :final-symbol="finalSymbols[0]" :is-spinning="reelSpinning[0]" :duration="900" @spin-end="onReelSpinEnd" />
          <ReelColumn :final-symbol="finalSymbols[1]" :is-spinning="reelSpinning[1]" :duration="900" @spin-end="onReelSpinEnd" />
          <ReelColumn :final-symbol="finalSymbols[2]" :is-spinning="reelSpinning[2]" :duration="900" @spin-end="onReelSpinEnd" />
        </div>

        <!-- 拉桿點擊區 -->
        <button class="lever-btn" :disabled="spinDisabled" aria-label="拉桿旋轉" @click="handleLeverPull" />
      </section>

      <!-- 保底提示徽章 -->
      <Transition name="fade">
        <div v-if="pendingResult?.pityActive === true && !isAnimating" class="pity-badge">
          🎯 保底生效
        </div>
      </Transition>

      <!-- ─── 注額控制 ────────────────────────────── -->
      <section class="controls" aria-label="旋轉控制">
        <div class="bet-row">
          <span class="bet-label">注額</span>
          <div class="bet-buttons" role="group" aria-label="選擇注額">
            <button
              v-for="amount in SLOT_BET_AMOUNTS"
              :key="amount"
              class="bet-btn"
              :class="{ selected: slotStore.betAmount === amount }"
              :disabled="spinDisabled"
              :aria-pressed="slotStore.betAmount === amount"
              @click="selectBet(amount)"
            >
              {{ amount }}
            </button>
          </div>
        </div>
      </section>

      <!-- ─── 底部工具列 ─────────────────────────────────── -->
      <section class="bottom-bar">
        <!-- 護符裝備槽（M13） -->
        <CharmSlotBar @toast="showToast" />

        <div class="bottom-right">
          <!-- 保底進度 -->
          <PityIndicator />

          <!-- 賠率表 -->
          <button class="paytable-btn" @click="showPaytable = true">
            📋 賠率表
          </button>
        </div>
      </section>
    </main>

    <!-- ─── 賠率表 Modal ───────────────────────────────── -->
    <PaytableModal v-model="showPaytable" />
  </div>
</template>

<style scoped>
/* ── Layout ── */
.slot-view {
  min-height: 100dvh;
  background: linear-gradient(160deg, #0d0d1a 0%, #1a1a2e 60%, #16213e 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
}

/* ── Header ── */
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.25rem;
  background: rgba(0, 0, 0, 0.4);
  border-bottom: 1px solid rgba(255, 215, 0, 0.2);
  position: sticky;
  top: 0;
  z-index: 100;
}

.back-btn {
  color: rgba(255, 255, 255, 0.6);
  text-decoration: none;
  font-size: 0.88rem;
  transition: color 0.2s;
}

.back-btn:hover { color: #ffd700; }

.page-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: #ffd700;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.username {
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.85rem;
}

.bgm-toggle-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  width: 2rem;
  height: 2rem;
  font-size: 0.95rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.2s;
}

.bgm-toggle-btn:hover {
  border-color: rgba(255, 215, 0, 0.5);
}

/* ── Jackpot Ticker ── */
.jackpot-ticker {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.5rem;
  background: rgba(255, 215, 0, 0.08);
  border-bottom: 1px solid rgba(255, 215, 0, 0.15);
  font-size: 0.9rem;
}

.jackpot-label { color: rgba(255, 255, 255, 0.6); }

.jackpot-amount {
  font-weight: 700;
  color: #ffd700;
  font-size: 1rem;
}

/* ── Toast ── */
.toast {
  position: fixed;
  top: 72px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(20, 20, 40, 0.95);
  border: 1px solid rgba(255, 215, 0, 0.4);
  border-radius: 8px;
  padding: 0.55rem 1.2rem;
  font-size: 0.9rem;
  color: #fff;
  z-index: 200;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}

.toast-enter-active, .toast-leave-active { transition: opacity 0.25s, transform 0.25s; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translateX(-50%) translateY(-8px); }

/* ── Main ── */
.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.5rem;
  padding: 1.5rem 1rem 2rem;
  max-width: 840px;
  width: 100%;
  margin: 0 auto;
}

/* ── Machine Cabinet ── */
.machine-wrapper {
  position: relative;
  width: min(780px, 98vw);
  max-width: 100%;
}

.machine-cabinet {
  width: 100%;
  display: block;
  pointer-events: none;
  user-select: none;
  position: relative;
  z-index: 2;
}

/* 滾輪放在機台圖下層，透過透明視窗透出 */
.reels-inner {
  position: absolute;
  left: 28%;
  top: 35%;
  width: 44%;
  height: 25%;
  display: flex;
  align-items: stretch;
  justify-content: center;
  gap: 0;
  z-index: 1;
}

/* 滾輪符號縮小以配合機台視窗 */
.reels-inner :deep(.reel-column) {
  flex: 1;
  min-width: 0;
  height: 100%;
  gap: 0;
}

.reels-inner :deep(.reel-window) {
  width: 100%;
  height: 100%;
  border: none;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
}

.reels-inner :deep(.symbol) {
  width: 105%;
  height: 105%;
  object-fit: contain;
}

.reels-inner :deep(.symbol-label) {
  display: none;
}

/* 拉桿點擊區（透明，疊在機台圖的拉桿位置） */
.lever-btn {
  position: absolute;
  right: 0;
  top: 20%;
  width: 20%;
  height: 55%;
  background: transparent;
  border: none;
  cursor: pointer;
  z-index: 3;
}

.lever-btn:disabled {
  cursor: not-allowed;
}

/* ── Win Overlay ── */
.win-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 10;
  gap: 2px;
}

.win-label {
  font-size: 1.6rem;
  font-weight: 900;
  color: #ffd700;
  text-shadow: 0 0 20px rgba(255, 215, 0, 0.8);
  letter-spacing: 0.1em;
}

.win-amount {
  font-size: 2.2rem;
  font-weight: 900;
  color: #fff;
  text-shadow: 0 0 16px rgba(255, 255, 255, 0.5);
}

.win-unit {
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.6);
}

.win-enter-active { animation: winPop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
.win-leave-active { transition: opacity 0.3s ease; }
.win-leave-to { opacity: 0; }

@keyframes winPop {
  from { opacity: 0; transform: scale(0.7); }
  to   { opacity: 1; transform: scale(1); }
}

/* ── Pity Badge ── */
.pity-badge {
  font-size: 0.8rem;
  color: #ffd700;
  background: rgba(255, 215, 0, 0.12);
  border: 1px solid rgba(255, 215, 0, 0.3);
  border-radius: 6px;
  padding: 3px 10px;
  margin-top: 8px;
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* ── Controls ── */
.controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.9rem;
  width: 100%;
}

.bet-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.bet-label {
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.5);
  min-width: 2.5rem;
}

.bet-buttons {
  display: flex;
  gap: 0.5rem;
}

.bet-btn {
  padding: 0.45rem 1rem;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(255, 255, 255, 0.75);
  font-size: 0.92rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s;
}

.bet-btn:hover:not(:disabled) {
  border-color: rgba(255, 215, 0, 0.5);
  color: #ffd700;
}

.bet-btn.selected {
  border-color: #ffd700;
  background: rgba(255, 215, 0, 0.15);
  color: #ffd700;
}

.bet-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}


/* ── Bottom Bar ── */
.bottom-bar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  width: 100%;
  gap: 1rem;
  flex-wrap: wrap;
}

.bottom-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.6rem;
}

.paytable-btn {
  padding: 0.4rem 0.9rem;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.paytable-btn:hover {
  border-color: rgba(255, 215, 0, 0.4);
  color: #ffd700;
}

/* ── Responsive ── */
@media (max-width: 400px) {
  .reels { padding: 1rem; }
  .reel-separator { width: 6px; }
  .spin-btn { max-width: 100%; }
}
</style>
