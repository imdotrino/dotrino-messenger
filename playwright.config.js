import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  reporter: 'list',
  use: {
    headless: false,
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  }
})
