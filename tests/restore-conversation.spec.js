import { test, expect, chromium } from '@playwright/test'

/**
 * Test que la conversación activa persiste tras reload.
 * Usa el localStorage del Messenger; corre contra la build local (vite preview).
 *
 * SITE_URL apunta a la app desplegada — el cambio aún no está deployed,
 * así que este test sirve como sanity check del comportamiento del store
 * tras el cambio (lo correremos contra preview local antes de deployar).
 */
const SITE = process.env.SITE_URL || 'http://localhost:4173'

test('restaura la última conversación abierta tras reload', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch({ headless: true })
  const aliceCtx = await browser.newContext()
  const bobCtx = await browser.newContext()
  const alice = await aliceCtx.newPage()
  const bob = await bobCtx.newPage()

  for (const p of [alice, bob]) {
    p.on('pageerror', e => console.log('PAGEERROR', e.message))
  }

  await alice.goto(SITE)
  await bob.goto(SITE)

  for (const [page, nick] of [[alice, 'AliceR'], [bob, 'BobR']]) {
    const input = page.locator('input[placeholder*="alice" i], input[placeholder*="ej." i]').first()
    if (await input.isVisible({ timeout: 8000 }).catch(() => false)) {
      await input.fill(nick)
      await page.getByRole('button', { name: /continuar/i }).first().click()
    }
  }

  const aliceTok = await alice.locator('.tok').first().innerText({ timeout: 30000 })

  // Bob añade a Alice.
  await bob.locator('button.add-btn').first().click()
  await bob.locator('input.mono').first().fill(aliceTok)
  await bob.getByRole('button', { name: /enviar saludo/i }).click()
  await alice.waitForTimeout(8000)

  // Alice abre la conversación con Bob.
  await alice.locator('.item').first().click({ timeout: 10000 })
  await alice.locator('.composer textarea').waitFor({ timeout: 5000 })

  const stored = await alice.evaluate(() => localStorage.getItem('messenger_active_pubkey_v1'))
  expect(stored, 'activePubkey debe quedar en localStorage').toBeTruthy()
  console.log('stored activePubkey:', stored?.slice(0, 24) + '…')

  // Reload de Alice.
  await alice.reload()

  // Tras reload, debe verse la conversación SIN clicks adicionales.
  await expect(alice.locator('.composer textarea')).toBeVisible({ timeout: 15_000 })

  await browser.close()
})
