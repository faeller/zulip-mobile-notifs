import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  base: './', // relative paths for github pages
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
