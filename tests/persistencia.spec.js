import { test, expect, chromium } from '@playwright/test'

/**
 * LO QUE SE GUARDA SIGUE AHÍ, Y ES DE QUIEN ES.
 *
 * Dos cosas que se rompieron de verdad y que ninguna prueba miraba:
 *
 *   1. que los contactos y el hilo sobrevivan a recargar y a cerrar la pestaña;
 *   2. que al CAMBIAR DE CUENTA no se arrastre nada de la anterior. Esto es lo que
 *      producía el «el perfil no era coherente»: la app enseñaba el nombre de la
 *      cuenta vieja sobre una identidad nueva y vacía —otro avatar, sin contactos,
 *      sin chats— y encima le escribía ese nombre a la cuenta nueva, dejando dos
 *      cuentas con el mismo nombre y distinta llave.
 *
 *   npx playwright test tests/persistencia.spec.js                (contra producción)
 *   SITE_URL=http://localhost:4173 npx playwright test            (contra un preview)
 */
const SITE = process.env.SITE_URL || 'https://messenger.dotrino.com'
const CODE_RE = /^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$/
const ESPERA = 45_000
const marca = Math.random().toString(36).slice(2, 6).toUpperCase()

async function entrar (context, apodo) {
  const page = await context.newPage()
  await page.addInitScript(() => {
    for (const id of ['profile', 'token', 'add', 'share', 'contacts', 'compose']) {
      try { localStorage.setItem(`messenger.tutorial:seen:${id}`, '1') } catch (_) {}
    }
  })
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  const nick = page.getByTestId('nickname-input')
  await nick.waitFor({ timeout: ESPERA })
  await nick.fill(apodo)
  await page.getByTestId('nickname-submit').click()
  return page
}

/** Habla con el vault por su propio protocolo, como haría otra app del ecosistema. */
async function vault (page, method, params = {}) {
  return await page.evaluate(async ({ method, params }) => {
    const ifr = [...document.querySelectorAll('iframe')].find(f => (f.src || '').includes('id.dotrino.com'))
    if (!ifr) throw new Error('no vault iframe')
    const id = 'test_' + Math.random().toString(36).slice(2)
    return await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout ' + method)), 10000)
      const h = (ev) => {
        const m = ev.data
        if (!m || m._cci !== true || m.type !== 'response' || m.id !== id) return
        clearTimeout(t); window.removeEventListener('message', h)
        m.error ? rej(new Error(m.error)) : res(m.result)
      }
      window.addEventListener('message', h)
      ifr.contentWindow.postMessage({ _cci: true, type: 'request', id, method, params }, '*')
    })
  }, { method, params })
}

test('contactos y mensajes siguen ahí tras recargar y tras cerrar la pestaña', async () => {
  test.setTimeout(240_000)
  const browser = await chromium.launch()
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  try {
    const ana = await entrar(ctxA, `Per${marca}A`)
    const beto = await entrar(ctxB, `Per${marca}B`)

    const chip = ana.getByTestId('my-code')
    await chip.waitFor({ timeout: ESPERA })
    await expect.poll(async () => (await chip.textContent()).trim(), { timeout: ESPERA }).toMatch(CODE_RE)
    const codigo = (await chip.textContent()).trim()

    await beto.getByTestId('add-contact').click()
    await beto.getByTestId('code-input').fill(codigo)
    await beto.getByTestId('send-hello').click()

    const aceptar = ana.getByTestId('accept-request').first()
    await aceptar.waitFor({ timeout: ESPERA })
    await aceptar.click()

    await ana.getByTestId('contact-item').first().click()
    await beto.getByTestId('contact-item').first().click()
    const texto = `persistencia ${marca}`
    await beto.getByTestId('composer-input').fill(texto)
    await beto.getByTestId('send-message').click()
    await expect(ana.getByTestId('msg-in').filter({ hasText: texto })).toBeVisible({ timeout: ESPERA })

    // 1) recargar
    await ana.reload({ waitUntil: 'domcontentloaded' })
    await ana.getByTestId('contact-item').first().click({ timeout: ESPERA })
    await expect(ana.getByTestId('msg-in').filter({ hasText: texto })).toBeVisible({ timeout: ESPERA })

    // 2) cerrar la pestaña y volver a entrar
    await ana.close()
    const ana2 = await ctxA.newPage()
    await ana2.goto(SITE, { waitUntil: 'domcontentloaded' })
    await ana2.getByTestId('contact-item').first().click({ timeout: ESPERA })
    await expect(ana2.getByTestId('msg-in').filter({ hasText: texto })).toBeVisible({ timeout: ESPERA })
  } finally {
    await browser.close().catch(() => {})
  }
})

test('cambiar de cuenta no arrastra el nombre ni los chats de la anterior', async () => {
  test.setTimeout(240_000)
  const browser = await chromium.launch()
  const ctx = await browser.newContext()
  try {
    const apodo = `Cta${marca}`
    const page = await entrar(ctx, apodo)
    await expect(page.locator('.who')).toHaveText(`@${apodo}`, { timeout: ESPERA })
    const primera = await vault(page, 'currentProfile')

    // Nace una cuenta SIN nombre y queda activa: es lo que pasa al emparejar con una
    // bóveda, al adoptar un perfil, y también cuando a este aparato lo echan y el
    // arranque estrena otra en su lugar.
    const nueva = await vault(page, 'createProfile', { name: '' })
    expect(nueva.id).not.toBe(primera.id)

    await page.reload({ waitUntil: 'domcontentloaded' })

    // La cuenta nueva no tiene apodo, así que la app lo PIDE. Antes estampaba el de la
    // cuenta anterior y seguía como si nada.
    await expect(page.getByTestId('nickname-input')).toBeVisible({ timeout: ESPERA })

    // Y no se lo escribió al vault: la cuenta nueva sigue sin nombre, no renombrada
    // con el de la vieja.
    const perfiles = await vault(page, 'listProfiles')
    const creada = perfiles.find(p => p.id === nueva.id)
    expect(creada, 'la cuenta nueva tiene que seguir existiendo').toBeTruthy()
    expect(creada.name, 'la cuenta nueva NO puede heredar el nombre de la anterior').not.toBe(apodo)

    // Al volver a la cuenta de antes, su apodo sigue siendo suyo.
    await vault(page, 'switchProfile', { id: primera.id })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect(page.locator('.who')).toHaveText(`@${apodo}`, { timeout: ESPERA })
  } finally {
    await browser.close().catch(() => {})
  }
})
