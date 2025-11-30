<script setup lang="ts">
import { ref, computed } from 'vue'
import { Capacitor } from '@capacitor/core'
import type { NotificationMethod } from '../lib/types'

defineProps<{
  showTitle?: boolean
  current?: NotificationMethod | null
  compact?: boolean
}>()

const emit = defineEmits<{
  select: [method: NotificationMethod]
}>()

const isNative = computed(() => Capacitor.isNativePlatform())
const showMoreInfo = ref(false)

// svg icon paths
const BellIcon = `<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`
const CloudIcon = `<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>`
const TabIcon = `<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/>`
const ServerIcon = `<rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>`
const RadioIcon = `<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>`
</script>

<template>
  <div class="method-selector" :class="{ compact }">
    <div class="method-options">
      <!-- AVAILABLE OPTIONS FIRST -->

      <!-- foreground service (android) - only show as available on native -->
      <button
        v-if="isNative"
        class="option-btn"
        :class="{ active: current === 'foreground-service' }"
        @click="emit('select', 'foreground-service')"
      >
        <span class="option-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="BellIcon" />
        </span>
        <span class="option-text">
          <strong>Foreground Service (recommended)</strong>
          <small>Instant notifications, credentials stay on device</small>
          <small class="caveat">Uses slightly more battery to keep connection open, but negligible on most devices</small>
        </span>
      </button>

      <!-- web push (cloudflare worker) - only show as available on web -->
      <button
        v-if="!isNative"
        class="option-btn"
        :class="{ active: current === 'web-push' }"
        @click="emit('select', 'web-push')"
      >
        <span class="option-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="CloudIcon" />
        </span>
        <span class="option-text">
          <strong>Web Push (recommended)</strong>
          <small>Instant when tab open, ~15s delay when closed</small>
          <small class="caveat">Credentials sent to server (encrypted, easily self-hostable)</small>
        </span>
      </button>

      <!-- tab only (web) -->
      <button
        v-if="!isNative"
        class="option-btn"
        :class="{ active: current === 'tab-only' }"
        @click="emit('select', 'tab-only')"
      >
        <span class="option-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="TabIcon" />
        </span>
        <span class="option-text">
          <strong>Tab Only</strong>
          <small>Instant notifications, fully private</small>
          <small class="caveat">Only works when browser tab is open</small>
        </span>
      </button>

      <!-- UNAVAILABLE OPTIONS (greyed out) -->

      <!-- foreground service greyed out on web -->
      <button v-if="!isNative" class="option-btn disabled" disabled>
        <span class="option-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="BellIcon" />
        </span>
        <span class="option-text">
          <strong>Foreground Service (recommended) <span class="platform-tag">Android</span></strong>
          <small>Instant notifications, credentials stay on device</small>
        </span>
      </button>

      <!-- unified push (coming soon) -->
      <button class="option-btn disabled" disabled>
        <span class="option-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="RadioIcon" />
        </span>
        <span class="option-text">
          <strong>UnifiedPush <span class="platform-tag">Android</span></strong>
          <small>Privacy-friendly push via your own server</small>
          <small class="coming-soon">Coming soon</small>
        </span>
      </button>

      <!-- web push greyed out on native -->
      <button v-if="isNative" class="option-btn disabled" disabled>
        <span class="option-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="CloudIcon" />
        </span>
        <span class="option-text">
          <strong>Web Push <span class="platform-tag">Web</span></strong>
          <small>Background notifications via Cloudflare worker</small>
        </span>
      </button>

      <!-- long-poll server (coming soon) -->
      <button class="option-btn disabled" disabled>
        <span class="option-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" v-html="ServerIcon" />
        </span>
        <span class="option-text">
          <strong>Long-Poll Server</strong>
          <small>Self-hosted server for instant notifications</small>
          <small class="coming-soon">Coming soon</small>
        </span>
      </button>
    </div>

    <!-- more info toggle -->
    <button v-if="!compact" class="more-info-toggle" @click="showMoreInfo = !showMoreInfo">
      {{ showMoreInfo ? 'Hide details' : 'About security & privacy' }}
    </button>

    <div v-if="showMoreInfo && !compact" class="more-info">
      <p>
        <strong>Why does Web Push need my credentials?</strong> This is how push infrastructure works. The server needs to poll Zulip on your behalf to know when to send notifications. We'd love to not store credentials, but there's no way around it.
      </p>
      <p>
        Your credentials are encrypted (AES-256) on the server. The <a href="https://github.com/faeller/zulip-mobile-notifs/tree/main/worker" target="_blank">worker code is open source</a>, but that doesn't mean you should trust the server. Code can change, servers can be compromised.
      </p>
      <p>
        <strong>For best security:</strong> use Foreground Service (Android) or <a href="https://github.com/faeller/zulip-mobile-notifs/tree/main/worker" target="_blank">host your own worker</a>. We built this for convenience, not as a trusted service.
      </p>
    </div>
  </div>
</template>

<style scoped>
.method-selector {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.method-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.option-btn {
  display: flex;
  align-items: flex-start;
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
}

.option-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: #333;
}

.option-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.option-btn.active {
  border-color: var(--primary);
  background: rgba(99, 102, 241, 0.1);
}

.option-icon {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.option-icon svg {
  width: 20px;
  height: 20px;
  color: var(--text-secondary);
}

.option-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.option-text strong {
  font-size: 15px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.option-text small {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.4;
}

.caveat {
  color: var(--warning) !important;
  font-size: 12px !important;
}

.platform-tag {
  font-size: 10px;
  font-weight: 500;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg);
  color: var(--text-secondary);
  border: 1px solid var(--border);
}

.coming-soon {
  font-size: 11px !important;
  font-style: italic;
  color: var(--text-secondary) !important;
}

.more-info-toggle {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 12px 8px;
  cursor: pointer;
  text-align: center;
  margin-top: 8px;
}

.more-info-toggle:hover {
  color: var(--text);
}

.more-info {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 16px;
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.more-info p {
  margin-bottom: 12px;
}

.more-info p:last-child {
  margin-bottom: 0;
}

.more-info a {
  color: var(--primary);
}

.more-info strong {
  color: var(--text);
}

/* compact mode */
.compact .method-options {
  gap: 8px;
}

.compact .option-btn {
  padding: 12px;
}

.compact .option-icon {
  width: 32px;
  height: 32px;
}

.compact .option-icon svg {
  width: 16px;
  height: 16px;
}

.compact .option-text strong {
  font-size: 14px;
}

.compact .option-text small {
  font-size: 12px;
}

.compact .caveat {
  display: none;
}
</style>
