<script setup lang="ts">
import { ref, computed } from 'vue'
import type { ZulipCredentials } from '../lib/types'

const props = defineProps<{
  credentials: ZulipCredentials
  disabled?: boolean
}>()

const emit = defineEmits<{
  use: []
  delete: []
}>()

const confirmingDelete = ref(false)

// display label for auth method
const authMethodLabel = computed(() => {
  switch (props.credentials.authMethod) {
    case 'password': return 'password'
    case 'sso': return 'SSO'
    case 'zuliprc': return 'zuliprc'
    case 'manual': return 'manual'
    default: return null
  }
})

function handleDeleteClick() {
  if (confirmingDelete.value) {
    emit('delete')
    confirmingDelete.value = false
  } else {
    confirmingDelete.value = true
  }
}

function cancelDelete() {
  confirmingDelete.value = false
}
</script>

<template>
  <div class="saved-credentials">
    <button class="saved-btn" :disabled="disabled" @click="$emit('use')">
      <span class="saved-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
      </span>
      <span class="saved-text">
        <strong>{{ credentials.email }}</strong>
        <small>
          {{ credentials.serverUrl }}
          <span v-if="authMethodLabel" class="auth-badge">{{ authMethodLabel }}</span>
        </small>
      </span>
      <!-- delete button inside the component -->
      <button
        type="button"
        class="delete-icon-btn"
        :class="{ confirming: confirmingDelete }"
        :disabled="disabled"
        @click.stop="handleDeleteClick"
        :title="confirmingDelete ? 'Click again to confirm' : 'Delete saved credentials'"
      >
        <svg v-if="!confirmingDelete" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </button>
    </button>
    <!-- cancel hint when confirming -->
    <div v-if="confirmingDelete" class="delete-hint" @click="cancelDelete">
      tap elsewhere to cancel
    </div>
  </div>
</template>

<style scoped>
.saved-credentials {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.saved-btn {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
  width: 100%;
  position: relative;
}

.saved-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: #333;
}

.saved-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.saved-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.saved-icon svg {
  width: 20px;
  height: 20px;
  color: var(--text-secondary);
}

.saved-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.saved-text strong {
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.saved-text small {
  font-size: 13px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.auth-badge {
  display: inline-block;
  padding: 1px 6px;
  background: var(--bg);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.delete-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}

.delete-icon-btn:hover:not(:disabled) {
  background: var(--error-bg);
  color: var(--error);
}

.delete-icon-btn.confirming {
  background: var(--error);
  color: white;
}

.delete-icon-btn.confirming:hover:not(:disabled) {
  background: var(--danger-hover);
}

.delete-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.delete-icon-btn svg {
  width: 18px;
  height: 18px;
}

.delete-hint {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
  cursor: pointer;
  padding: 4px;
}

.delete-hint:hover {
  color: var(--text);
}
</style>
