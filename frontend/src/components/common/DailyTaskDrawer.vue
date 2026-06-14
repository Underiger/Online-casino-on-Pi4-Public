<template>
  <!-- 抽屜遮罩 -->
  <Teleport to="body">
    <div v-if="open" class="drawer-overlay" @click.self="emit('close')">
      <aside class="drawer">
        <!-- 標頭 -->
        <header class="drawer-header">
          <span class="drawer-title">每日任務</span>
          <button class="close-btn" aria-label="關閉" @click="emit('close')">✕</button>
        </header>

        <!-- 載入中 -->
        <div v-if="daily.isLoading" class="loading">載入中…</div>

        <div v-else class="drawer-body">
          <!-- 今日幸運符號 -->
          <section class="section lucky-section">
            <h3 class="section-title">今日幸運符號</h3>
            <div class="lucky-symbol">
              <span class="symbol-icon">{{ symbolIcon(daily.luckySymbol) }}</span>
              <span class="symbol-name">{{ symbolName(daily.luckySymbol) }}</span>
            </div>
          </section>

          <!-- 每日登入獎勵 -->
          <section class="section login-section">
            <h3 class="section-title">每日登入</h3>
            <div v-if="loginRewardInfo" class="login-reward claimed">
              <span>已獲得 <strong>{{ loginRewardInfo.reward }}</strong> Coin</span>
              <span class="streak-badge">連續 {{ loginRewardInfo.streak }} 天 ×{{ loginRewardInfo.multiplier }}</span>
            </div>
            <button
              v-else
              class="claim-login-btn"
              :disabled="claimingLogin"
              @click="handleClaimLogin"
            >
              {{ claimingLogin ? '領取中…' : '領取每日登入獎勵' }}
            </button>
            <p v-if="loginError" class="error-msg">{{ loginError }}</p>
          </section>

          <!-- 每日任務列表 -->
          <section class="section tasks-section">
            <h3 class="section-title">每日任務</h3>

            <div v-if="daily.tasks.length === 0" class="empty-hint">今日尚無任務，請稍後再試。</div>

            <div v-for="task in daily.tasks" :key="task.id" class="task-card">
              <div class="task-header">
                <span class="task-name">{{ task.name }}</span>
                <span class="task-reward">
                  +{{ task.rewardCoin }} Coin
                  <span v-if="task.rewardCharm" class="charm-tag">護符</span>
                </span>
              </div>

              <!-- 進度條 -->
              <div class="progress-bar-wrap">
                <div
                  class="progress-bar-fill"
                  :style="{ width: progressPct(task) + '%' }"
                  :class="{ completed: task.progress >= task.target }"
                />
              </div>
              <div class="progress-label">
                {{ task.progress }} / {{ task.target }}
                <span v-if="task.claimed" class="claimed-tag">已領取</span>
              </div>

              <!-- 領取按鈕 -->
              <button
                v-if="task.progress >= task.target && !task.claimed"
                class="claim-task-btn"
                :disabled="claimingTask === task.id"
                @click="handleClaimTask(task.id)"
              >
                {{ claimingTask === task.id ? '領取中…' : '領取獎勵' }}
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import type { DailyTaskItem } from '@casino/shared';
import { SlotSymbol } from '@casino/shared';
import { useDailyStore } from '../../stores/daily';
import type { DailyLoginRes } from '@casino/shared';

// ─── Props & Emits ────────────────────────────────────────────────────────────

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

// ─── Store ────────────────────────────────────────────────────────────────────

const daily = useDailyStore();
const claimingLogin = ref(false);
const claimingTask = ref<string | null>(null);
const loginRewardInfo = ref<DailyLoginRes | null>(null);
const loginError = ref<string | null>(null);

// 開啟抽屜時載入並訂閱 socket
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      daily.connectSocket();
      await daily.fetchTasks();
    } else {
      daily.disconnectSocket();
    }
  },
);

// ─── 每日登入獎勵 ──────────────────────────────────────────────────────────────

async function handleClaimLogin(): Promise<void> {
  claimingLogin.value = true;
  loginError.value = null;
  const res = await daily.claimLogin();
  claimingLogin.value = false;
  if (res !== null) {
    loginRewardInfo.value = res;
  } else {
    const code = daily.error ?? '';
    if (code === 'CONFLICT_ERROR' || code.includes('CONFLICT')) {
      loginError.value = '今日登入獎勵已領取';
    } else {
      loginError.value = '領取失敗，請稍後再試';
    }
  }
}

// ─── 任務領取 ─────────────────────────────────────────────────────────────────

async function handleClaimTask(progressId: string): Promise<void> {
  claimingTask.value = progressId;
  await daily.claimTask(progressId);
  claimingTask.value = null;
}

// ─── 輔助函式 ─────────────────────────────────────────────────────────────────

function progressPct(task: DailyTaskItem): number {
  return Math.min(Math.round((task.progress / task.target) * 100), 100);
}

const SYMBOL_ICON: Record<string, string> = {
  [SlotSymbol.CHERRY]:  '🍒',
  [SlotSymbol.LEMON]:   '🍋',
  [SlotSymbol.BELL]:    '🔔',
  [SlotSymbol.BAR]:     '🎰',
  [SlotSymbol.CLOVER]:  '🍀',
  [SlotSymbol.LUCKY7]:  '7️⃣',
  [SlotSymbol.DIAMOND]: '💎',
  [SlotSymbol.WILD]:    '⭐',
};

const SYMBOL_NAME: Record<string, string> = {
  [SlotSymbol.CHERRY]:  '櫻桃',
  [SlotSymbol.LEMON]:   '檸檬',
  [SlotSymbol.BELL]:    '鈴鐺',
  [SlotSymbol.BAR]:     'BAR',
  [SlotSymbol.CLOVER]:  '幸運草',
  [SlotSymbol.LUCKY7]:  '幸運 7',
  [SlotSymbol.DIAMOND]: '鑽石',
  [SlotSymbol.WILD]:    '百搭',
};

function symbolIcon(s: string | null): string {
  if (s === null) return '❓';
  return SYMBOL_ICON[s] ?? s;
}

function symbolName(s: string | null): string {
  if (s === null) return '尚未設定';
  return SYMBOL_NAME[s] ?? s;
}
</script>

<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 200;
  display: flex;
  justify-content: flex-end;
}

.drawer {
  width: min(380px, 95vw);
  height: 100dvh;
  background: #1a1a2e;
  border-left: 1px solid rgba(255, 215, 0, 0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ── 標頭 ── */
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid rgba(255, 215, 0, 0.15);
  background: rgba(0, 0, 0, 0.3);
  flex-shrink: 0;
}

.drawer-title {
  font-size: 1.1rem;
  font-weight: 700;
  color: #ffd700;
}

.close-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0.25rem;
  transition: color 0.15s;
}

.close-btn:hover {
  color: #fff;
}

/* ── Body ── */
.loading {
  padding: 2rem;
  text-align: center;
  color: rgba(255, 255, 255, 0.5);
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* ── Sections ── */
.section-title {
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.4);
  margin: 0 0 0.75rem;
}

/* ── 幸運符號 ── */
.lucky-symbol {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  background: rgba(255, 215, 0, 0.08);
  border: 1px solid rgba(255, 215, 0, 0.25);
  border-radius: 10px;
}

.symbol-icon {
  font-size: 2rem;
}

.symbol-name {
  font-size: 1.1rem;
  font-weight: 600;
  color: #ffd700;
}

/* ── 登入獎勵 ── */
.login-reward {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  border-radius: 8px;
  font-size: 0.9rem;
  color: #86efac;
}

.login-reward strong {
  color: #ffd700;
}

.streak-badge {
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  background: rgba(255, 215, 0, 0.15);
  border-radius: 99px;
  color: #fbbf24;
  white-space: nowrap;
}

.claim-login-btn {
  width: 100%;
  padding: 0.75rem;
  border-radius: 8px;
  border: 1px solid rgba(255, 215, 0, 0.4);
  background: rgba(255, 215, 0, 0.1);
  color: #ffd700;
  font-size: 0.95rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.claim-login-btn:hover:not(:disabled) {
  background: rgba(255, 215, 0, 0.2);
}

.claim-login-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.error-msg {
  font-size: 0.8rem;
  color: #f87171;
  margin: 0.4rem 0 0;
}

/* ── 任務卡片 ── */
.task-card {
  padding: 0.85rem 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.task-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
}

.task-name {
  font-size: 0.9rem;
  font-weight: 600;
  color: #e2e8f0;
}

.task-reward {
  font-size: 0.78rem;
  color: #fbbf24;
  white-space: nowrap;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.charm-tag {
  font-size: 0.68rem;
  padding: 0.1rem 0.35rem;
  background: rgba(167, 139, 250, 0.25);
  border-radius: 4px;
  color: #c4b5fd;
}

/* ── 進度條 ── */
.progress-bar-wrap {
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: #3b82f6;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.progress-bar-fill.completed {
  background: #22c55e;
}

.progress-label {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.45);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.claimed-tag {
  padding: 0.1rem 0.4rem;
  background: rgba(34, 197, 94, 0.15);
  border-radius: 4px;
  color: #86efac;
  font-size: 0.68rem;
}

/* ── 領取按鈕 ── */
.claim-task-btn {
  align-self: flex-end;
  padding: 0.4rem 1rem;
  border-radius: 6px;
  border: 1px solid rgba(34, 197, 94, 0.4);
  background: rgba(34, 197, 94, 0.12);
  color: #86efac;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.claim-task-btn:hover:not(:disabled) {
  background: rgba(34, 197, 94, 0.25);
}

.claim-task-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
