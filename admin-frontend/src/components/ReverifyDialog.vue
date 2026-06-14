<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-overlay" @click.self="emit('cancelled')">
      <div class="modal">
        <div class="modal__header">2FA 重新驗證</div>
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
        <div class="modal__footer">
          <button class="btn btn--ghost" :disabled="loading" @click="emit('cancelled')">
            取消
          </button>
          <button
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
import { ref, watch, nextTick } from 'vue';
import { apiTotpReverify, extractErrorMessage } from '../api/admin';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  verified: [token: string];
  cancelled: [];
}>();

const totpCode = ref('');
const loading = ref(false);
const errMsg = ref('');
const totpInputRef = ref<HTMLInputElement | null>(null);

watch(
  () => props.modelValue,
  async (val) => {
    if (val) {
      totpCode.value = '';
      errMsg.value = '';
      await nextTick();
      totpInputRef.value?.focus();
    }
  },
);

async function submit(): Promise<void> {
  if (totpCode.value.length !== 6 || loading.value) return;
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
