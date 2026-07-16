import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  reporter: 'list',
  use: {
    // La app es bilingüe (§9) y arranca en el idioma del navegador cuando no hay
    // preferencia guardada. Los specs buscan los botones por su texto en español
    // ("continuar", "enviar saludo"), así que fijamos el locale: sin esto, en una
    // máquina/CI en inglés la UI sale en inglés y los tests no encuentran nada.
    locale: 'es-EC',
    headless: false,
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  }
})
