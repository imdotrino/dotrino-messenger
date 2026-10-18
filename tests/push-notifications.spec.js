import { test, expect, chromium } from '@playwright/test'

const SITE = process.env.SITE_URL || 'https://messenger.dotrino.com'

/**
 * Verificación E2E de Web Push en el browser real (contra prod).
 *
 * LÍMITE conocido de Chromium automatizado: NO puede crear una PushSubscription
 * (`pushManager.subscribe` → "permission denied", falta la API key de GCM/FCM),
 * ni recibir un push real de FCM. Por eso NO testeamos enablePush() ni la entrega
 * por la red de Google. SÍ testeamos:
 *   1. El handler de push del Service Worker desplegado (dotrino-push-sw.js
 *      inyectado en el SW de Workbox vía importScripts): entregamos un push con
 *      CDP `ServiceWorker.deliverPushMessage` (lo mismo que el botón "Push" de
 *      DevTools) y verificamos que dispara `cc-push-ring` a la página.
 *   2. La cola offline que el push complementa: un DM a un peer offline queda
 *      encolado y se entrega al reconectar.
 */

test('SW: el handler de push desplegado dispara cc-push-ring', async () => {
  test.setTimeout(90_000)
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  await ctx.grantPermissions(['notifications'], { origin: SITE })
  const page = await ctx.newPage()
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })

  // El SW de la PWA (Workbox + importScripts del handler de push) ya se registra
  // al cargar. Esperamos a que esté activo.
  await page.evaluate(() => navigator.serviceWorker.ready)

  // Capturamos los postMessage 'cc-push-ring' que el SW manda a la página.
  await page.evaluate(() => {
    window.__rings = []
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'cc-push-ring') window.__rings.push(e.data)
    })
  })

  // Entregamos un push "ring" directamente al SW vía CDP (sin subscription).
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('ServiceWorker.enable')
  let registrationId = null
  cdp.on('ServiceWorker.workerRegistrationUpdated', (ev) => {
    for (const r of ev.registrations || []) {
      if (r.scopeURL && r.scopeURL.includes(new URL(SITE).host)) registrationId = r.registrationId
    }
  })
  await page.waitForTimeout(1500)
  expect(registrationId, 'no se encontró el registrationId del SW').not.toBeNull()

  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: SITE,
    registrationId,
    data: JSON.stringify({ type: 'ring', ts: Date.now() })
  })

  // El handler de push (solo existe en dotrino-push-sw.js) debe haber
  // posteado cc-push-ring → prueba que el importScripts funcionó en el deploy.
  await expect.poll(
    async () => (await page.evaluate(() => window.__rings.length)),
    { timeout: 10_000, message: 'el SW no posteó cc-push-ring' }
  ).toBeGreaterThan(0)

  await browser.close()
})

/**
 * LA COLA OFFLINE que el push complementa: un texto a alguien desconectado espera en el
 * proxio y le llega al volver a abrir la app. (La foto por la cola la cubre friends.spec.)
 *
 * Antes estaba en `test.skip` con selectores de la UI vieja (`.tok`, `.item`, `.bubble`):
 * el alta de contacto ya completa en Chromium headless, así que corre con los `data-testid`
 * de hoy.
 */
const WAIT = 45_000
const runTag = Math.random().toString(36).slice(2, 6).toUpperCase()

async function enter (browser, nickname) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // El tutorial tapa la UI con burbujas y no es lo que se prueba aquí.
  await context.addInitScript(() => {
    for (const id of ['profile', 'token', 'add', 'share', 'contacts', 'compose']) {
      try { localStorage.setItem(`messenger.tutorial:seen:${id}`, '1') } catch (_) {}
    }
  })
  const page = await context.newPage()
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  const nick = page.getByTestId('nickname-input')
  await nick.waitFor({ timeout: WAIT })
  await nick.fill(nickname)
  await page.getByTestId('nickname-submit').click()
  return { context, page }
}

test('cola offline: DM a un peer offline se entrega al reconectar', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const alice = await enter(browser, `Alice${runTag}`)
  const bob = await enter(browser, `Bob${runTag}`)
  try {
    const chip = alice.page.getByTestId('my-code')
    await chip.waitFor({ timeout: WAIT })
    await expect.poll(async () => (await chip.textContent()).trim(), { timeout: WAIT })
      .toMatch(/^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$/)
    const aliceCode = (await chip.textContent()).trim()

    // Bob añade a Alice por código → saludo, y Alice acepta la solicitud.
    await bob.page.getByTestId('add-contact').click()
    await bob.page.getByTestId('code-input').fill(aliceCode)
    await bob.page.getByTestId('send-hello').click()
    const ok = alice.page.getByTestId('accept-request').first()
    await ok.waitFor({ timeout: WAIT })
    await ok.click()
    await alice.page.getByTestId('contact-item').first().click()
    await bob.page.getByTestId('contact-item').first().click()

    // Bob se va OFFLINE: se cierra su página (su WS se desconecta). El contexto
    // (almacén e identidad) se conserva para reabrir como la misma persona.
    await bob.page.close()
    await expect(alice.page.getByTestId('route')).toHaveAttribute('data-route', 'offline', { timeout: WAIT })

    // Alice le escribe a Bob desconectado → cae a la cola del proxio.
    const message = `offline ${runTag} ${Date.now()}`
    await alice.page.getByTestId('composer-input').fill(message)
    await alice.page.getByTestId('send-message').click()
    // El ✓ dice que el proxio ya lo tiene en la cola; antes de eso Bob no tiene nada que drenar.
    await expect(alice.page.getByTestId('msg-out').filter({ hasText: message }).locator('.check'))
      .toHaveText('✓', { timeout: WAIT })

    // Bob reabre (mismo contexto) → reconecta, identify drena la cola.
    bob.page = await bob.context.newPage()
    await bob.page.goto(SITE, { waitUntil: 'domcontentloaded' })
    const item = bob.page.getByTestId('contact-item').first()
    await item.waitFor({ timeout: WAIT })
    await item.click()
    await expect(bob.page.getByTestId('msg-in').filter({ hasText: message })).toBeVisible({ timeout: WAIT })
  } finally {
    await alice.context.close().catch(() => {})
    await bob.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})
