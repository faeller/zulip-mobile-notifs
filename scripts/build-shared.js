#!/usr/bin/env node
// transpile shared TS to ES6 for rhino 1.8+ compatibility

import { build } from 'esbuild'
import { mkdirSync } from 'fs'

const outDir = 'android/app/src/main/assets'

// ensure output dir exists
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: ['src/shared/zulip-service.ts'],
  outfile: `${outDir}/zulip-service.js`,
  bundle: true,
  format: 'iife',
  globalName: 'ZulipService',
  target: 'es2015', // rhino 1.8+ supports ES6
  minify: false, // keep readable for debugging
  sourcemap: false,
  banner: {
    js: '// auto-generated from src/shared/zulip-service.ts - do not edit\n'
  },
  // expose global functions for rhino
  footer: {
    js: `
// expose for rhino global scope
var initService = ZulipService.initService;
var updateSettings = ZulipService.updateSettings;
var processMessage = ZulipService.processMessage;
var filterMessage = ZulipService.filterMessage;
var formatMessage = ZulipService.formatMessage;
var formatTime = ZulipService.formatTime;
`
  }
})

console.log('✓ built zulip-service.js for android')
