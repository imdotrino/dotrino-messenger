import { test, expect, chromium } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * LA VUELTA ENTERA: dos amigos se emparejan y se escriben.
 *
 * Es el único camino que importa de verdad —que dos personas que no se conocen
 * acaben conversando— y va de punta a punta: el código de 6 caracteres, el
 * saludo, la solicitud, aceptarla, un mensaje de ida y otro de vuelta. Después la
 * misma vuelta por el otro camino: una tercera persona entra escaneando el QR.
 *
 *   npx playwright test tests/amigos.spec.js                 (contra producción)
 *   SITE_URL=http://localhost:4173 npx playwright test       (contra un preview)
 *
 * Cada amigo va en SU PROPIO contexto: almacenamiento aparte, o sea identidades
 * distintas de verdad y no dos pestañas del mismo.
 */
const SITE = process.env.SITE_URL || 'https://messenger.dotrino.com'
const CODE_RE = /^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$/
const ESPERA = 45_000

/** Marca de esta corrida: los apodos y los mensajes no se pisan entre pruebas. */
const marca = Math.random().toString(36).slice(2, 6).toUpperCase()

async function entrar (browser, apodo) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // El tutorial tapa la UI con burbujas y no es lo que se prueba aquí.
  await context.addInitScript(() => {
    for (const id of ['profile', 'token', 'add', 'share', 'contacts', 'compose']) {
      try { localStorage.setItem(`messenger.tutorial:seen:${id}`, '1') } catch (_) {}
    }
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log(`[${apodo}] PAGEERROR`, e.message))
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  const nick = page.getByTestId('nickname-input')
  await nick.waitFor({ timeout: ESPERA })
  await nick.fill(apodo)
  await page.getByTestId('nickname-submit').click()
  return { context, page, apodo }
}

/** El código de emparejamiento que enseña la barra superior (6 caracteres). */
async function codigoDe (amigo) {
  const chip = amigo.page.getByTestId('my-code')
  await chip.waitFor({ timeout: ESPERA })
  await expect.poll(async () => (await chip.textContent()).trim(), { timeout: ESPERA })
    .toMatch(CODE_RE)
  return (await chip.textContent()).trim()
}

async function abrirConversacion (amigo) {
  const item = amigo.page.getByTestId('contact-item').first()
  await item.waitFor({ timeout: ESPERA })
  await item.click()
}

async function escribir (amigo, texto) {
  await amigo.page.getByTestId('composer-input').fill(texto)
  await amigo.page.getByTestId('send-message').click()
}

async function aceptarSolicitud (amigo) {
  const ok = amigo.page.getByTestId('accept-request').first()
  await ok.waitFor({ timeout: ESPERA })
  await ok.click()
}

test('dos amigos se emparejan con el código y se escriben', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await entrar(browser, `Ana${marca}`)
  const beto = await entrar(browser, `Beto${marca}`)

  try {
    // 1) Ana ve su código: 6 caracteres que puede dictar por teléfono.
    const codigoAna = await codigoDe(ana)
    expect(codigoAna, 'el código de la barra no tiene la forma esperada').toMatch(CODE_RE)

    // 2) Beto la agrega con ese código y le manda el saludo.
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(codigoAna)
    await beto.page.getByTestId('send-hello').click()

    // 3) A Ana le llega la solicitud y la acepta.
    await aceptarSolicitud(ana)

    // 4) El código es de un solo uso: en cuanto alguien lo gasta, la barra tiene
    //    que enseñar otro. Si no, el siguiente amigo teclea uno muerto.
    await expect.poll(async () => (await ana.page.getByTestId('my-code').textContent()).trim(),
      { timeout: ESPERA, message: 'el código gastado se quedó en pantalla' })
      .not.toBe(codigoAna)

    // 5) Ida y vuelta de mensajes. Se abre la conversación en LOS DOS lados antes de
    //    escribir: un mensaje que llega antes de que el contacto esté guardado va a
    //    la bandeja de solicitudes, y entonces esto probaría otra cosa.
    await abrirConversacion(ana)
    const deBeto = `hola ana, soy beto ${marca}`
    await abrirConversacion(beto)
    await escribir(beto, deBeto)

    await expect(ana.page.getByTestId('msg-in').filter({ hasText: deBeto }))
      .toBeVisible({ timeout: ESPERA })

    const deAna = `te leo, beto ${marca}`
    await escribir(ana, deAna)
    await expect(beto.page.getByTestId('msg-in').filter({ hasText: deAna }))
      .toBeVisible({ timeout: ESPERA })
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

test('una amiga entra escaneando el QR del otro', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await entrar(browser, `Ana${marca}Q`)
  const carla = await entrar(browser, `Carla${marca}`)
  const png = path.join(os.tmpdir(), `dotrino-qr-${marca}.png`)

  try {
    await codigoDe(ana)

    // 1) Ana enseña su QR. Se guarda la imagen para dársela al escáner: es la
    //    misma que vería una cámara apuntando a la pantalla, sin cámara de por medio.
    await ana.page.getByTestId('add-contact').click()
    await ana.page.getByTestId('share-my-token-tab').click()
    const qr = ana.page.getByTestId('my-qr')
    await qr.waitFor({ timeout: ESPERA })
    await qr.screenshot({ path: png })
    expect(fs.statSync(png).size, 'la captura del QR salió vacía').toBeGreaterThan(0)
    await ana.page.keyboard.press('Escape')

    // 2) Carla abre el escáner y le da la foto. El input vive en el Shadow DOM de
    //    <dotrino-qr-scan>; Playwright lo atraviesa solo.
    await carla.page.getByTestId('add-contact').click()
    await carla.page.getByTestId('scan-qr').click()
    const file = carla.page.locator('dotrino-qr-scan input[type=file]')
    await file.waitFor({ state: 'attached', timeout: ESPERA })
    await file.setInputFiles(png)

    // 3) De ahí sale el saludo sin teclear nada: a Ana le llega la solicitud.
    await aceptarSolicitud(ana)

    // 4) Y conversan, que es la prueba de que el emparejamiento fue real.
    const deCarla = `vengo por el QR ${marca}`
    await abrirConversacion(carla)
    await escribir(carla, deCarla)
    await abrirConversacion(ana)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: deCarla }))
      .toBeVisible({ timeout: ESPERA })
  } finally {
    try { fs.unlinkSync(png) } catch (_) {}
    await ana.context.close().catch(() => {})
    await carla.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

test('el enlace del QR abre la app con el código puesto', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await entrar(browser, `Ana${marca}L`)
  let dani = null

  try {
    const codigo = await codigoDe(ana)

    // Quien apunta la cámara del sistema al QR no entra a la app: entra al ENLACE
    // que lleva dentro. Ese camino tiene que dejar el código escrito, o la persona
    // acaba tecleando lo mismo que acaba de escanear.
    dani = await entrar(browser, `Dani${marca}`)
    await dani.page.goto(`${SITE}#add=${codigo}`, { waitUntil: 'domcontentloaded' })

    const input = dani.page.getByTestId('code-input')
    await input.waitFor({ timeout: ESPERA })
    await expect(input).toHaveValue(codigo)
    // Y el enlace se limpia: recargar no reintenta un código ya quemado.
    expect(await dani.page.evaluate(() => location.hash)).toBe('')

    await dani.page.getByTestId('send-hello').click()
    await aceptarSolicitud(ana)
  } finally {
    await ana.context.close().catch(() => {})
    if (dani) await dani.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})
