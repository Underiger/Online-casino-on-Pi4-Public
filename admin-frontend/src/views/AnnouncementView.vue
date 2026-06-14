<template>
  <div>
    <div class="page-header">
      <h2 class="page-title">公告管理</h2>
      <button class="btn btn--primary" @click="openCreate">+ 新增公告</button>
    </div>

    <!-- 公告列表 -->
    <div class="card">
      <div v-if="loading" class="loading-text">載入中…</div>
      <template v-else>
        <div style="overflow-x: auto">
          <table>
            <thead>
              <tr>
                <th>標題</th>
                <th>狀態</th>
                <th>開始時間</th>
                <th>結束時間</th>
                <th>建立時間</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in announcements" :key="item.id">
                <td style="font-weight: 500; max-width: 200px">{{ item.title }}</td>
                <td>
                  <span class="badge" :class="item.active ? 'badge--green' : 'badge--gray'">
                    {{ item.active ? '啟用' : '停用' }}
                  </span>
                </td>
                <td>{{ item.startsAt ? fmtDate(item.startsAt) : '—' }}</td>
                <td>{{ item.endsAt ? fmtDate(item.endsAt) : '無限期' }}</td>
                <td>{{ fmtDate(item.createdAt) }}</td>
                <td>
                  <div style="display: flex; gap: 6px">
                    <button class="btn btn--ghost btn--sm" @click="openEdit(item)">編輯</button>
                    <button class="btn btn--danger btn--sm" @click="confirmDelete(item)">刪除</button>
                  </div>
                </td>
              </tr>
              <tr v-if="announcements.length === 0">
                <td colspan="6" style="text-align: center; color: #94a3b8; padding: 30px">
                  尚無公告
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <!-- 新增 / 編輯 Dialog -->
    <Teleport to="body">
      <div v-if="formDialog" class="modal-overlay" @click.self="formDialog = null">
        <div class="modal" style="width: 500px">
          <div class="modal__header">
            {{ formDialog.mode === 'create' ? '新增公告' : '編輯公告' }}
          </div>
          <div class="form-group">
            <label>標題 <span class="required">*</span></label>
            <input
              v-model="formData.title"
              class="form-control"
              type="text"
              maxlength="60"
              placeholder="公告標題…"
            />
          </div>
          <div class="form-group">
            <label>內容 <span class="required">*</span></label>
            <textarea
              v-model="formData.content"
              class="form-control"
              rows="4"
              maxlength="500"
              placeholder="公告內容…"
            />
          </div>
          <div class="form-row">
            <div class="form-group" style="flex: 1">
              <label>開始時間（選填）</label>
              <input v-model="formData.startsAt" class="form-control" type="datetime-local" />
            </div>
            <div class="form-group" style="flex: 1">
              <label>結束時間（選填）</label>
              <input v-model="formData.endsAt" class="form-control" type="datetime-local" />
            </div>
          </div>
          <div class="form-group">
            <label class="checkbox-label">
              <input v-model="formData.active" type="checkbox" />
              立即啟用
            </label>
          </div>
          <div v-if="formErr" class="error-msg" style="margin-bottom: 8px">{{ formErr }}</div>
          <div class="modal__footer">
            <button class="btn btn--ghost" :disabled="formLoading" @click="formDialog = null">
              取消
            </button>
            <button
              class="btn btn--primary"
              :disabled="formLoading || !formData.title || !formData.content"
              @click="submitForm"
            >
              {{ formLoading ? '儲存中…' : '儲存' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 刪除確認 Dialog -->
    <Teleport to="body">
      <div v-if="deleteTarget" class="modal-overlay" @click.self="deleteTarget = null">
        <div class="modal">
          <div class="modal__header">確認刪除</div>
          <p style="color: #475569; margin-bottom: 16px">
            確定要刪除公告「<strong>{{ deleteTarget.title }}</strong>」嗎？此操作無法復原。
          </p>
          <div v-if="formErr" class="error-msg" style="margin-bottom: 8px">{{ formErr }}</div>
          <div class="modal__footer">
            <button class="btn btn--ghost" :disabled="formLoading" @click="deleteTarget = null">
              取消
            </button>
            <button class="btn btn--danger" :disabled="formLoading" @click="submitDelete">
              {{ formLoading ? '刪除中…' : '確認刪除' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useUiStore } from '../stores/ui';
import {
  apiListAnnouncements,
  apiCreateAnnouncement,
  apiUpdateAnnouncement,
  apiDeleteAnnouncement,
  extractErrorMessage,
  type AnnouncementItem,
} from '../api/admin';

const ui = useUiStore();
const announcements = ref<AnnouncementItem[]>([]);
const loading = ref(false);

interface FormDialog {
  mode: 'create' | 'edit';
  id?: string;
}
const formDialog = ref<FormDialog | null>(null);
const formData = ref({ title: '', content: '', active: true, startsAt: '', endsAt: '' });
const formLoading = ref(false);
const formErr = ref('');
const deleteTarget = ref<AnnouncementItem | null>(null);

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('zh-TW', { hour12: false });
}

async function fetchAnnouncements(): Promise<void> {
  loading.value = true;
  try {
    const res = await apiListAnnouncements();
    announcements.value = res.items;
  } catch (err) {
    ui.addToast(extractErrorMessage(err), 'error');
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  formDialog.value = { mode: 'create' };
  formData.value = { title: '', content: '', active: true, startsAt: '', endsAt: '' };
  formErr.value = '';
}

function openEdit(item: AnnouncementItem): void {
  formDialog.value = { mode: 'edit', id: item.id };
  formData.value = {
    title: item.title,
    content: item.content,
    active: item.active,
    startsAt: item.startsAt ? toLocalDT(item.startsAt) : '',
    endsAt: item.endsAt ? toLocalDT(item.endsAt) : '',
  };
  formErr.value = '';
}

function toLocalDT(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function confirmDelete(item: AnnouncementItem): void {
  deleteTarget.value = item;
  formErr.value = '';
}

async function submitForm(): Promise<void> {
  if (!formDialog.value) return;
  formLoading.value = true;
  formErr.value = '';

  const payload: {
    title: string;
    content: string;
    active?: boolean;
    startsAt?: string;
    endsAt?: string;
  } = {
    title: formData.value.title,
    content: formData.value.content,
    active: formData.value.active,
  };
  if (formData.value.startsAt) payload.startsAt = new Date(formData.value.startsAt).toISOString();
  if (formData.value.endsAt) payload.endsAt = new Date(formData.value.endsAt).toISOString();

  try {
    if (formDialog.value.mode === 'create') {
      await apiCreateAnnouncement(payload);
      ui.addToast('公告已建立', 'success');
    } else {
      await apiUpdateAnnouncement(formDialog.value.id!, payload);
      ui.addToast('公告已更新', 'success');
    }
    formDialog.value = null;
    await fetchAnnouncements();
  } catch (err) {
    formErr.value = extractErrorMessage(err);
  } finally {
    formLoading.value = false;
  }
}

async function submitDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  formLoading.value = true;
  formErr.value = '';
  try {
    await apiDeleteAnnouncement(deleteTarget.value.id);
    ui.addToast('公告已刪除', 'success');
    deleteTarget.value = null;
    await fetchAnnouncements();
  } catch (err) {
    formErr.value = extractErrorMessage(err);
  } finally {
    formLoading.value = false;
  }
}

onMounted(() => fetchAnnouncements());
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.page-title {
  font-size: 20px;
  font-weight: 700;
  color: #1e293b;
}
.loading-text {
  text-align: center;
  padding: 40px;
  color: #94a3b8;
}
.form-row {
  display: flex;
  gap: 16px;
}
.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-weight: 500;
}
.required {
  color: #dc2626;
}
</style>
