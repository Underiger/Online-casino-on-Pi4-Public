<template>
  <RouterView />
  <div class="toast-container">
    <TransitionGroup name="toast">
      <div
        v-for="toast in ui.toasts"
        :key="toast.id"
        class="toast"
        :class="`toast--${toast.type}`"
        @click="ui.removeToast(toast.id)"
      >
        {{ toast.message }}
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { useUiStore } from './stores/ui';

const ui = useUiStore();
</script>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  color: #1e293b;
  background: #f1f5f9;
}

input,
select,
textarea,
button {
  font-family: inherit;
  font-size: 14px;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-weight: 500;
  transition: opacity 0.15s;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn--primary {
  background: #2563eb;
  color: #fff;
}
.btn--primary:hover:not(:disabled) {
  background: #1d4ed8;
}
.btn--danger {
  background: #dc2626;
  color: #fff;
}
.btn--danger:hover:not(:disabled) {
  background: #b91c1c;
}
.btn--success {
  background: #16a34a;
  color: #fff;
}
.btn--success:hover:not(:disabled) {
  background: #15803d;
}
.btn--ghost {
  background: transparent;
  color: #475569;
  border: 1px solid #cbd5e1;
}
.btn--ghost:hover:not(:disabled) {
  background: #f1f5f9;
}
.btn--sm {
  padding: 3px 10px;
  font-size: 12px;
}

.card {
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  padding: 20px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 16px;
}
.form-group label {
  font-weight: 500;
  color: #374151;
}
.form-control {
  padding: 8px 12px;
  border: 1px solid #d1d5db;
  border-radius: 6px;
  outline: none;
  transition: border-color 0.15s;
  width: 100%;
}
.form-control:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

table {
  width: 100%;
  border-collapse: collapse;
}
thead th {
  text-align: left;
  padding: 10px 12px;
  background: #f8fafc;
  border-bottom: 2px solid #e2e8f0;
  font-weight: 600;
  color: #475569;
  white-space: nowrap;
}
tbody td {
  padding: 10px 12px;
  border-bottom: 1px solid #e2e8f0;
  vertical-align: middle;
}
tbody tr:last-child td {
  border-bottom: none;
}
tbody tr:hover {
  background: #f8fafc;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 600;
}
.badge--red {
  background: #fef2f2;
  color: #b91c1c;
}
.badge--green {
  background: #f0fdf4;
  color: #15803d;
}
.badge--gray {
  background: #f1f5f9;
  color: #475569;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.modal {
  background: #fff;
  border-radius: 10px;
  padding: 24px;
  width: 400px;
  max-width: 90vw;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.2);
}
.modal__header {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 20px;
  color: #1e293b;
}
.modal__footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 24px;
}

.error-msg {
  color: #dc2626;
  font-size: 13px;
  margin-top: 4px;
}

.toast-container {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  padding: 12px 18px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  max-width: 320px;
  pointer-events: auto;
  cursor: pointer;
  font-size: 14px;
  line-height: 1.4;
}
.toast--success {
  background: #16a34a;
  color: #fff;
}
.toast--error {
  background: #dc2626;
  color: #fff;
}
.toast--info {
  background: #2563eb;
  color: #fff;
}
.toast--warning {
  background: #d97706;
  color: #fff;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from {
  transform: translateX(100%);
  opacity: 0;
}
.toast-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>
