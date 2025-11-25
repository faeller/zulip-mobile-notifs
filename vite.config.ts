import { defineConfig } from 'vite'

export default defineConfig({
  base: './', // relative paths for github pages
  build: {
    outDir: 'dist',
    sourcemap: true
  }
})
