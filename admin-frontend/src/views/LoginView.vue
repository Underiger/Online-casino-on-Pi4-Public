<template>
  <div class="login-page">
    <div class="login-card">
      <h1 class="login-title">Casino 管理後台</h1>

      <!-- Step 1: 帳密輸入 -->
      <template v-if="step === 'credentials'">
        <div class="form-group">
          <label>使用者名稱</label>
          <input
            v-model="username"
            class="form-control"
            type="text"
            placeholder="admin"
            autocomplete="username"
            @keyup.enter="focusPassword"
          />
        </div>
        <div class="form-group">
          <label>密碼</label>
          <input
            ref="passwordRef"
            v-model="password"
            class="form-control"
            type="password"
            placeholder="••••••••"
            autocomplete="current-password"
            @keyup.enter="submitCredentials"
          />
        </div>
        <div v-if="errMsg" class="error-msg" style="margin-bottom: 12px">{{ errMsg }}</div>
        <button
          class="btn btn--primary"
          style="width: 100%"
          :disabled="loading || !username || !password"
          @click="submitCredentials"
        >
          {{ loading ? '登入中…' : '登入' }}
        </button>
      </template>

      <!-- Step 2: TOTP 驗證 -->
      <template v-else-if="step === 'totp'">
        <p class="totp-hint">請輸入 Authenticator App 中的驗證碼</p>

        <div class="totp-mode-switch">
          <button
            class="mode-btn"
            :class="{ 'mode-btn--active': totpMode === 'totp' }"
            @click="totpMode = 'totp'"
          >
            TOTP 驗證碼
          </button>
          <button
            class="mode-btn"
            :class="{ 'mode-btn--active': totpMode === 'recovery' }"
            @click="totpMode = 'recovery'"
          >
            備用碼
          </button>
        </div>

        <div class="form-group">
          <label>{{ totpMode === 'totp' ? '6 位數驗證碼' : '備用碼（格式：xxxxx-xxxxx）' }}</label>
          <input
            ref="totpInputRef"
            v-model="totpCode"
            class="form-control totp-input"
            :type="totpMode === 'totp' ? 'text' : 'text'"
            :inputmode="totpMode === 'totp' ? 'numeric' : 'text'"
            :maxlength="totpMode === 'totp' ? 6 : 11"
            :placeholder="totpMode === 'totp' ? '000000' : 'xxxxx-xxxxx'"
            @keyup.enter="submitTotp"
          />
        </div>
        <div v-if="errMsg" class="error-msg" style="margin-bottom: 12px">{{ errMsg }}</div>
        <div style="display: flex; gap: 8px">
          <button class="btn btn--ghost" style="flex: 1" @click="backToCredentials">返回</button>
          <button
            class="btn btn--primary"
            style="flex: 2"
            :disabled="loading || !totpCode"
            @click="submitTotp"
          >
            {{ loading ? '驗證中…' : '確認' }}
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { useAdminAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import { apiLogin, apiAdminMe, apiTotpValidate, extractErrorMessage } from '../api/admin';

type Step = 'credentials' | 'totp';
type TotpMode = 'totp' | 'recovery';

const auth = useAdminAuthStore();
const ui = useUiStore();
const router = useRouter();

const step = ref<Step>('credentials');
const username = ref('');
const password = ref('');
const totpCode = ref('');
const totpMode = ref<TotpMode>('totp');
const loading = ref(false);
const errMsg = ref('');

const passwordRef = ref<HTMLInputElement | null>(null);
const totpInputRef = ref<HTMLInputElement | null>(null);

function focusPassword(): void {
  passwordRef.value?.focus();
}

function backToCredentials(): void {
  step.value = 'credentials';
  totpCode.value = '';
  errMsg.value = '';
}

async function submitCredentials(): Promise<void> {
  if (!username.value || !password.value || loading.value) return;
  loading.value = true;
  errMsg.value = '';
  try {
    const loginRes = await apiLogin(username.value, password.value);
    auth.setTokens(loginRes.accessToken, loginRes.refreshToken);

    const me = await apiAdminMe();
    if (me.role !== 'ADMIN') {
      auth.clear();
      errMsg.value = '帳號無管理員權限';
      return;
    }
    auth.setUser({ id: me.userId, username: me.username, role: me.role, totpEnabled: me.totpEnabled });

    if (!me.totpEnabled) {
      ui.addToast('登入成功', 'success');
      await router.push('/players');
    } else {
      step.value = 'totp';
      await nextTick();
      totpInputRef.value?.focus();
    }
  } catch (err) {
    errMsg.value = extractErrorMessage(err) || '帳號或密碼錯誤';
    auth.clear();
  } finally {
    loading.value = false;
  }
}

async function submitTotp(): Promise<void> {
  if (!totpCode.value || loading.value) return;
  loading.value = true;
  errMsg.value = '';
  try {
    const res = await apiTotpValidate(totpCode.value);
    auth.setReverifyToken(res.reverifyToken, res.expiresIn);
    ui.addToast('登入成功', 'success');
    await router.push('/players');
  } catch (err) {
    errMsg.value = extractErrorMessage(err) || '驗證碼錯誤，請重試';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
}

.login-card {
  background: #fff;
  border-radius: 12px;
  padding: 40px 36px;
  width: 380px;
  max-width: 90vw;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
}

.login-title {
  font-size: 22px;
  font-weight: 700;
  text-align: center;
  margin-bottom: 28px;
  color: #1e293b;
}

.totp-hint {
  color: #64748b;
  font-size: 13px;
  text-align: center;
  margin-bottom: 20px;
}

.totp-mode-switch {
  display: flex;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  overflow: hidden;
  margin-bottom: 20px;
}

.mode-btn {
  flex: 1;
  padding: 8px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  color: #64748b;
  transition: background 0.15s, color 0.15s;
}
.mode-btn--active {
  background: #2563eb;
  color: #fff;
}

.totp-input {
  text-align: center;
  letter-spacing: 4px;
  font-size: 20px;
  font-weight: 600;
}
</style>
