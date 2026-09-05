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
    // Sin ventana por defecto (esto corre en terminal y en CI); con HEADED=1 se ve.
    headless: process.env.HEADED !== '1',
    trace: 'retain-on-failure',
    video: 'retain-on-failure'
  }
})
