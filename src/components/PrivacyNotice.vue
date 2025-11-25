<template>
  <p class="privacy-notice">
    All credentials are stored locally on your device and never sent to any third-party server.
    This app is <a href="https://github.com/faeller/zulip-mobile-notifs" target="_blank">open source</a>, </br> 
    verify or build it yourself.
  </p>
</template>

<style scoped>
.privacy-notice {
  font-size: 13px;
  color: var(--text-secondary);
  text-align: center;
  line-height: 1.5;
  margin-top: 0;
  margin-bottom: 20px;
  padding: 0 8px;
}

.privacy-notice a {
  color: var(--primary);
  text-decoration: none;
}

.privacy-notice a:hover {
  text-decoration: underline;
}
</style>
