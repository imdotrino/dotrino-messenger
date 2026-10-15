import { test, expect, chromium } from '@playwright/test'

/**
 * EL MESSENGER ES POR CUENTA, Y DOTRINO ESTÁ SIEMPRE.
 *
 *   · Dotrino es un contacto fijo: aparece sin agregarlo y no se puede quitar. Hasta que
 *     escriba no se conoce ninguno de sus aparatos, así que el campo de escribir se ve
 *     apagado y dice por qué.
 *   · El enlace `#to=<llave>&nick=…&card=…` (el que pone el correo de feedback) abre
 *     «añadir contacto» con esa persona puesta: la solicitud va a los aparatos de su
 *     tarjeta, sin código.
 *   · El contacto queda guardado por su cuenta (con tarjeta de perfil), y se escriben.
 *
 *   SITE_URL=http://localhost:4173 npx playwright test tests/cuenta.spec.js
 */
const SITE = process.env.SITE_URL || 'https://messenger.dotrino.com'
const ESPERA = 45_000

async function entrar (browser, apodo) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => {
    for (const id of ['profile', 'token', 'add', 'share', 'contacts', 'compose']) {
      try { localStorage.setItem(`messenger.tutorial:seen:${id}`, '1') } catch (_) {}
    }
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log(`[${apodo}] PAGEERROR`, e.message))
  await page.goto(SITE)
  await page.getByTestId('nickname-input').fill(apodo)
  await page.getByTestId('nickname-submit').click()
  await page.getByTestId('my-code').waitFor({ timeout: ESPERA })
  return { context, page }
}

/** Los stores de la app (pinia), para leer lo que la UI no enseña: la llave y la tarjeta. */
const store = (page, name, fn) => page.evaluate(([n, src]) => {
  const s = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get(n)
  return new Function('s', 'return (' + src + ')(s)')(s)
}, [name, fn.toString()])

test('Dotrino fijo, enlace #to= y contacto por cuenta', async () => {
  const browser = await chromium.launch()
  const ana = await entrar(browser, 'Ana')
  const beto = await entrar(browser, 'Beto')

  // Dotrino está sin agregarlo, y sin aparatos conocidos no se le puede escribir todavía.
  await ana.page.getByTestId('contact-dotrino').click({ timeout: ESPERA })
  await expect(ana.page.getByTestId('no-devices')).toBeVisible()
  await expect(ana.page.getByTestId('composer-input')).toBeDisabled()

  // El enlace del correo: la llave de Beto en base64url, en el #fragment.
  await expect.poll(() => store(beto.page, 'connection', (s) => s.myPublickey), { timeout: ESPERA }).toBeTruthy()
  const llave = await store(beto.page, 'connection', (s) => s.myPublickey)
  const b64 = Buffer.from(llave).toString('base64url')
  // Con su tarjeta de perfil, como la pone el correo: se sella con las llaves que ella lista.
  const card = await beto.page.evaluate(() => document.querySelector('dotrino-topbar').identity.profileCard())
  expect(card, 'una cuenta recién creada ya tiene tarjeta').toBeTruthy()
  const cardB64 = Buffer.from(JSON.stringify(card)).toString('base64url')
  await ana.page.goto(SITE + '/#to=' + b64 + '&nick=Beto&card=' + cardB64)
  await expect(ana.page.getByTestId('to-info')).toContainText('Beto', { timeout: ESPERA })
  await ana.page.getByTestId('send-hello').click()

  await beto.page.getByTestId('accept-request').first().click({ timeout: ESPERA })
  await ana.page.getByTestId('contact-item').waitFor({ timeout: ESPERA })

  // Guardado por su CUENTA: con tarjeta de perfil, y se le escribe a sus aparatos.
  const beto4ana = await store(ana.page, 'contacts', (s) => s.contacts
    .filter((c) => !s.isPinned(c.publickey))
    .map((c) => ({ card: !!s.cardOf(c.publickey), devices: s.recipientsOf(c.publickey).length })))
  expect(beto4ana).toEqual([{ card: true, devices: 1 }])

  await ana.page.getByTestId('contact-item').click()
  await ana.page.getByTestId('composer-input').fill('hola por cuenta')
  await ana.page.getByTestId('send-message').click()
  await beto.page.getByTestId('contact-item').click()
  await expect(beto.page.getByTestId('msg-text').last()).toHaveText('hola por cuenta', { timeout: ESPERA })
  await browser.close()
})
