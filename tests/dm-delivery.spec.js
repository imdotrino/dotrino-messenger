import { test, expect, chromium } from '@playwright/test'

const SITE = process.env.SITE_URL || 'https://messenger.dotrino.com'

/**
 * Reproduce el flujo: dos pestañas (alice, bob), se agregan mutuamente por
 * token, alice envía un DM, bob debe verlo.
 *
 * Cada pestaña usa un browser context distinto para no compartir storage.
 */
test('dos peers se intercambian DM', async () => {
  test.setTimeout(120_000)

  const browser = await chromium.launch({ headless: false })
  const aliceCtx = await browser.newContext()
  const bobCtx = await browser.newContext()
  const alice = await aliceCtx.newPage()
  const bob = await bobCtx.newPage()

  alice.on('console', m => console.log('[alice]', m.type(), m.text()))
  bob.on('console',   m => console.log('[bob]',   m.type(), m.text()))
  alice.on('pageerror', e => console.log('[alice] PAGEERROR', e.message))
  bob.on('pageerror', e => console.log('[bob] PAGEERROR', e.message))

  await alice.goto(SITE)
  await bob.goto(SITE)

  // Set nicknames si modal está visible.
  for (const [page, nick] of [[alice, 'AliceTest'], [bob, 'BobTest']]) {
    const input = page.locator('input[placeholder*="alice" i], input[placeholder*="ej." i]').first()
    if (await input.isVisible({ timeout: 8000 }).catch(() => false)) {
      await input.fill(nick)
      await page.getByRole('button', { name: /continuar/i }).first().click()
    }
  }

  // Espera a que el token aparezca en topbar.
  const aliceTok = await alice.locator('.tok').first().innerText({ timeout: 30000 })
  const bobTok   = await bob.locator('.tok').first().innerText({ timeout: 30000 })
  console.log('alice token:', aliceTok, 'bob token:', bobTok)

  // Bob añade a Alice por su token.
  console.log('[test] Bob adds Alice…')
  await bob.locator('button.add-btn, button[title*="adir"]').first().click()
  await bob.locator('input.mono, input[placeholder*="A4F2" i]').first().fill(aliceTok)
  await bob.getByRole('button', { name: /enviar saludo/i }).click()
  console.log('[test] saludo enviado, esperando 10s al handshake…')
  await alice.waitForTimeout(10000)

  // Snapshot del DOM de ambos para diagnosticar.
  await alice.screenshot({ path: 'test-results/alice-after-handshake.png', fullPage: true })
  await bob.screenshot({ path: 'test-results/bob-after-handshake.png', fullPage: true })

  const aliceItems = await alice.locator('.item').count()
  const bobItems = await bob.locator('.item').count()
  console.log(`[test] alice items=${aliceItems} bob items=${bobItems}`)

  // Bob ya tiene a Alice como contacto (la añadió). Verificamos que Alice
  // también vió el HELLO de vuelta.
  expect(aliceItems, 'Alice no recibió HELLO de Bob').toBeGreaterThan(0)

  // Alice abre el contacto Bob y manda un mensaje.
  await alice.locator('.item').first().click({ timeout: 5000 })
  const message = 'hola-' + Date.now()
  await alice.locator('textarea').fill(message)
  await alice.locator('button.send').click()

  // Bob abre el contacto Alice y debería ver el mensaje.
  await bob.locator('.item').first().click({ timeout: 5000 })
  await expect(bob.locator('.bubble', { hasText: message })).toBeVisible({ timeout: 25_000 })

  await browser.close()
})
