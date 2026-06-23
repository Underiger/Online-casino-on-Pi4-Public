<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="emit('cancelled')">
      <div class="modal">
        <div class="modal__header">2FA 重新驗證</div>

        <div v-if="tgStatus !== 'idle'">
          <p
            v-if="tgStatus === 'pending'"
            style="color: #64748b; margin-bottom: 12px; font-size: 13px"
          >
            📱 已傳送核准請求至 Telegram，請在手機點擊「核准」完成驗證…
          </p>
          <p v-else-if="tgStatus === 'denied'" class="error-msg" style="margin-bottom: 12px">
            ❌ 已在 Telegram 拒絕此次驗證請求。
          </p>
          <p v-else class="error-msg" style="margin-bottom: 12px">⌛ 推播請求已逾時未回應。</p>

          <div style="display: flex; gap: 8px; margin-bottom: 16px">
            <button
              v-if="tgStatus !== 'pending'"
              class="btn btn--primary btn--sm"
              @click="retryTelegram"
            >
              重新傳送
            </button>
            <button class="btn btn--ghost btn--sm" @click="useManualCode">改用驗證碼</button>
          </div>
        </div>

        <template v-else>
          <p style="color: #64748b; margin-bottom: 16px; font-size: 13px">
            此操作需要即時驗證碼。請開啟 Authenticator App 輸入當前 6 位數 TOTP。
          </p>
          <div class="form-group">
            <label>TOTP 驗證碼</label>
            <input
              ref="totpInputRef"
              v-model="totpCode"
              class="form-control"
              type="text"
              inputmode="numeric"
              maxlength="6"
              placeholder="000000"
              @keyup.enter="submit"
            />
            <span v-if="errMsg" class="error-msg">{{ errMsg }}</span>
          </div>
        </template>

        <div class="modal__footer">
          <button class="btn btn--ghost" :disabled="loading" @click="emit('cancelled')">
            取消
          </button>
          <button
            v-if="tgStatus === 'idle'"
            class="btn btn--primary"
            :disabled="loading || totpCode.length !== 6"
            @click="submit"
          >
            {{ loading ? '驗證中…' : '確認' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onUnmounted } from 'vue';
import {
  apiTotpReverify,
  apiTotpReverifyTelegramStart,
  apiTotpReverifyTelegramStatus,
  extractErrorMessage,
} from '../api/admin';
import { useAdminAuthStore } from '../stores/auth';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  verified: [token: string];
  cancelled: [];
}>();

const auth = useAdminAuthStore();

const totpCode = ref('');
const loading = ref(false);
const errMsg = ref('');
const totpInputRef = ref<HTMLInputElement | null>(null);

/** 'idle'：顯示手動 TOTP 表單（今天的行為）；其餘三種：Telegram 推播流程中 */
type TgStatus = 'idle' | 'pending' | 'denied' | 'timeout';
const tgStatus = ref<TgStatus>('idle');
const tgRequestId = ref<string | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let tgDeadline = 0;

const TG_POLL_INTERVAL_MS = 1_500;
/** 逾時緩衝：確保剛好卡在伺服器端 TTL 邊界的核准結果，前端最後一次輪詢仍抓得到 */
const TG_TIMEOUT_BUFFER_MS = 5_000;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function focusTotpInput(): Promise<void> {
  await nextTick();
  totpInputRef.value?.focus();
}

/** 「改用驗證碼」：隨時可從 Telegram 等待畫面切回手動輸入，不被推播流程卡住 */
function useManualCode(): void {
  stopPolling();
  tgStatus.value = 'idle';
  void focusTotpInput();
}

async function pollTelegramStatus(): Promise<void> {
  if (tgRequestId.value === null) return;
  if (Date.now() > tgDeadline) {
    stopPolling();
    tgStatus.value = 'timeout';
    return;
  }
  try {
    const res = await apiTotpReverifyTelegramStatus(tgRequestId.value);
    if (res.status === 'approved' && res.reverifyToken !== undefined) {
      stopPolling();
      emit('update:modelValue', false);
      emit('verified', res.reverifyToken);
    } else if (res.status === 'denied') {
      stopPolling();
      tgStatus.value = 'denied';
    } else if (res.status === 'expired') {
      stopPolling();
      tgStatus.value = 'timeout';
    }
    // 'pending' → 繼續輪詢
  } catch {
    // 單次輪詢失敗（網路抖動）：不中斷，留給下一次 tick 或逾時處理
  }
}

async function startTelegramFlow(): Promise<void> {
  try {
    const res = await apiTotpReverifyTelegramStart();
    tgRequestId.value = res.requestId;
    tgStatus.value = 'pending';
    tgDeadline = Date.now() + res.expiresIn * 1000 + TG_TIMEOUT_BUFFER_MS;
    stopPolling();
    pollTimer = setInterval(pollTelegramStatus, TG_POLL_INTERVAL_MS);
  } catch {
    // Telegram 暫時無法使用（未設定 / 網路問題）：靜默 fallback 為手動輸入，不擋對話框
    tgStatus.value = 'idle';
    await focusTotpInput();
  }
}

async function retryTelegram(): Promise<void> {
  tgStatus.value = 'idle';
  tgRequestId.value = null;
  await startTelegramFlow();
}

watch(
  () => props.modelValue,
  async (val) => {
    if (!val) {
      stopPolling();
      return;
    }
    totpCode.value = '';
    errMsg.value = '';
    tgStatus.value = 'idle';
    tgRequestId.value = null;

    // 自動優先 Telegram 推播（已設定時）；TOTP 輸入框隨時可透過「改用驗證碼」切回
    if (auth.user?.telegramEnabled === true) {
      await startTelegramFlow();
    } else {
      await focusTotpInput();
    }
  },
);

onUnmounted(() => stopPolling());

async function submit(): Promise<void> {
  if (totpCode.value.length !== 6 || loading.value) return;
  stopPolling();
  loading.value = true;
  errMsg.value = '';
  try {
    const res = await apiTotpReverify(totpCode.value);
    emit('update:modelValue', false);
    emit('verified', res.reverifyToken);
  } catch (err) {
    errMsg.value = extractErrorMessage(err) || 'TOTP 驗證失敗，請重試';
  } finally {
    loading.value = false;
  }
}
</script>
