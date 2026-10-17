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
 *   npx playwright test tests/friends.spec.js                 (contra producción)
 *   SITE_URL=http://localhost:4173 npx playwright test       (contra un preview)
 *
 * Cada amigo va en SU PROPIO contexto: almacenamiento aparte, o sea identidades
 * distintas de verdad y no dos pestañas del mismo.
 */
const SITE = process.env.SITE_URL || 'https://messenger.dotrino.com'
const CODE_RE = /^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$/
const WAIT = 45_000

/** Marca de esta corrida: los apodos y los mensajes no se pisan entre pruebas. */
const runTag = Math.random().toString(36).slice(2, 6).toUpperCase()

async function enter (browser, nickname, { proxy } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  // El tutorial tapa la UI con burbujas y no es lo que se prueba aquí.
  await context.addInitScript(() => {
    for (const id of ['profile', 'token', 'add', 'share', 'contacts', 'compose']) {
      try { localStorage.setItem(`messenger.tutorial:seen:${id}`, '1') } catch (_) {}
    }
  })
  // Fijar el proxio de casa: sin esto cada uno elige el más rápido, y el caso de dos
  // nodos distintos sale o no según la suerte.
  if (proxy) await context.addInitScript((u) => { try { localStorage.setItem('messenger_proxy_url', u) } catch (_) {} }, proxy)
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log(`[${nickname}] PAGEERROR`, e.message))
  if (process.env.DEBUG_CONSOLE) page.on('console', (m) => { if (/cc-conn|messenger|part|queue|WS error|error/i.test(m.text())) console.log(`[${nickname}]`, m.text().slice(0, 200)) })
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  const nick = page.getByTestId('nickname-input')
  await nick.waitFor({ timeout: WAIT })
  await nick.fill(nickname)
  await page.getByTestId('nickname-submit').click()
  return { context, page, nickname }
}

/** El código de emparejamiento que enseña la barra superior (6 caracteres). */
async function codeOf (friend) {
  const chip = friend.page.getByTestId('my-code')
  await chip.waitFor({ timeout: WAIT })
  await expect.poll(async () => (await chip.textContent()).trim(), { timeout: WAIT })
    .toMatch(CODE_RE)
  return (await chip.textContent()).trim()
}

async function openConversation (friend) {
  const item = friend.page.getByTestId('contact-item').first()
  await item.waitFor({ timeout: WAIT })
  await item.click()
}

async function sendText (friend, text) {
  await friend.page.getByTestId('composer-input').fill(text)
  await friend.page.getByTestId('send-message').click()
}

async function acceptRequest (friend) {
  const ok = friend.page.getByTestId('accept-request').first()
  await ok.waitFor({ timeout: WAIT })
  await ok.click()
}

test('dos amigos se emparejan con el código y se escriben', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await enter(browser, `Ana${runTag}`)
  const beto = await enter(browser, `Beto${runTag}`)

  try {
    // 1) Ana ve su código: 6 caracteres que puede dictar por teléfono.
    const anaCode = await codeOf(ana)
    expect(anaCode, 'el código de la barra no tiene la forma esperada').toMatch(CODE_RE)

    // 2) Beto la agrega con ese código: le manda una SOLICITUD, no un mensaje.
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(anaCode)
    await beto.page.getByTestId('send-hello').click()

    // 3) A Ana le llega la solicitud. Es un mensaje de control entre los dos: en
    //    ningún chat de Ana aparece nada, y nadie es contacto de nadie todavía.
    await ana.page.getByTestId('accept-request').first().waitFor({ timeout: WAIT })
    await expect(ana.page.getByTestId('msg-in')).toHaveCount(0)
    // Nadie es contacto de nadie… salvo Dotrino, que está siempre y no se puede quitar.
    await expect(ana.page.getByTestId('contact-dotrino')).toHaveCount(1, { timeout: WAIT })
    await expect(ana.page.getByTestId('contact-item')).toHaveCount(0)
    await expect(beto.page.getByTestId('contact-item')).toHaveCount(0)
    await acceptRequest(ana)

    // 4) El código es de un solo uso: en cuanto alguien lo gasta, la barra tiene
    //    que enseñar otro. Si no, el siguiente amigo teclea uno muerto.
    await expect.poll(async () => (await ana.page.getByTestId('my-code').textContent()).trim(),
      { timeout: WAIT, message: 'el código gastado se quedó en pantalla' })
      .not.toBe(anaCode)

    // 5) Beto la ve en sus contactos cuando ella acepta (no antes), y se escriben.
    //    Ningún chat empezó con un mensaje de la solicitud.
    await openConversation(ana)
    await expect(ana.page.getByTestId('msg-in')).toHaveCount(0)
    const fromBeto = `hola ana, soy beto ${runTag}`
    await openConversation(beto)
    await sendText(beto, fromBeto)

    await expect(ana.page.getByTestId('msg-in').filter({ hasText: fromBeto }))
      .toBeVisible({ timeout: WAIT })

    const fromAna = `te leo, beto ${runTag}`
    await sendText(ana, fromAna)
    await expect(beto.page.getByTestId('msg-in').filter({ hasText: fromAna }))
      .toBeVisible({ timeout: WAIT })
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

/**
 * FOTOS: la imagen sale TAL CUAL (no se toca el contenido del usuario), en partes por el
 * transporte, y la otra punta recibe los mismos bytes. Y no se pierde al recargar.
 */
test('un amigo le manda una foto al otro, byte a byte', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await enter(browser, `Ana${runTag}F`)
  const beto = await enter(browser, `Beto${runTag}F`)
  try {
    const anaCode = await codeOf(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(anaCode)
    await beto.page.getByTestId('send-hello').click()
    await acceptRequest(ana)
    await openConversation(ana)
    await openConversation(beto)

    // Un PNG de ~5 MB con ruido (no comprime): el tamaño de una foto de teléfono.
    const png = await beto.page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 1300; c.height = 1000
      const ctx = c.getContext('2d')
      const img = ctx.createImageData(c.width, c.height)
      for (let i = 0; i < img.data.length; i += 65536) crypto.getRandomValues(img.data.subarray(i, i + 65536))
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255
      ctx.putImageData(img, 0, 0)
      return c.toDataURL('image/png').split(',')[1]
    })
    const caption = `mira esto ${runTag}`
    await beto.page.getByTestId('composer-input').fill(caption)
    const t0 = Date.now()
    await beto.page.getByTestId('file-input').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })

    const received = ana.page.getByTestId('msg-in').filter({ hasText: caption })
    const img = received.getByTestId('msg-image').locator('img')
    await expect(img).toBeVisible({ timeout: WAIT })
    console.log(`photo of ${(png.length * 0.75 / 1048576).toFixed(1)} MB delivered in ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    expect(await img.getAttribute('src'), 'llegan los mismos bytes, sin recomprimir').toBe(`data:image/png;base64,${png}`)

    // Quien la mandó la ve con el acuse (✓), y la foto sigue ahí al recargar.
    await expect(beto.page.getByTestId('msg-out').filter({ hasText: caption }).locator('.check')).toHaveText('✓', { timeout: WAIT })
    await ana.page.reload()
    await openConversation(ana)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: caption }).getByTestId('msg-image')).toBeVisible({ timeout: WAIT })
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

/**
 * FOTO A ALGUIEN DESCONECTADO: espera en el proxio (en el dotrino-content de su cuenta, hasta
 * 8 MB) y llega entera cuando vuelve a abrir la app.
 */
test('una foto para alguien desconectado le llega al volver', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  // En nodos distintos: Ana vive en proxy1 (su cola, en el content) y Beto escribe desde proxy2.
  const ana = await enter(browser, `Ana${runTag}O`, { proxy: 'wss://proxy.dotrino.com' })
  const beto = await enter(browser, `Beto${runTag}O`, { proxy: 'wss://proxy2.dotrino.com' })
  try {
    const anaCode = await codeOf(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(anaCode)
    await beto.page.getByTestId('send-hello').click()
    await acceptRequest(ana)
    await openConversation(ana)
    await openConversation(beto)
    // Que se hayan visto una vez (un texto de ida), y Ana cierra la app.
    await sendText(beto, `before ${runTag}`)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: `before ${runTag}` })).toBeVisible({ timeout: WAIT })
    await ana.page.close()
    await beto.page.waitForTimeout(3000)

    const png = await beto.page.evaluate(() => {
      const c = document.createElement('canvas')
      c.width = 1000; c.height = 800
      const ctx = c.getContext('2d')
      const img = ctx.createImageData(c.width, c.height)
      for (let i = 0; i < img.data.length; i += 65536) crypto.getRandomValues(img.data.subarray(i, i + 65536))
      for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255
      ctx.putImageData(img, 0, 0)
      return c.toDataURL('image/png').split(',')[1]
    })
    const caption = `mientras no estabas ${runTag}`
    await beto.page.getByTestId('composer-input').fill(caption)
    await beto.page.getByTestId('file-input').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    await beto.page.waitForTimeout(5000)

    // Ana vuelve: la cola del proxio le entrega la foto entera.
    ana.page = await ana.context.newPage()
    await ana.page.goto(SITE, { waitUntil: 'domcontentloaded' })
    await openConversation(ana)
    const img = ana.page.getByTestId('msg-in').filter({ hasText: caption }).getByTestId('msg-image').locator('img')
    await expect(img).toBeVisible({ timeout: WAIT })
    console.log(`photo of ${(png.length * 0.75 / 1048576).toFixed(1)} MB delivered from the queue`)
    expect(await img.getAttribute('src')).toBe(`data:image/png;base64,${png}`)
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

/**
 * CUALQUIER ARCHIVO, no solo fotos: llega con su nombre y se descarga con los mismos bytes.
 * Y la conversación dice por dónde va el contacto y con qué tope.
 */
test('un archivo que no es foto llega con su nombre y se descarga igual', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await enter(browser, `Ana${runTag}P`)
  const beto = await enter(browser, `Beto${runTag}P`)
  try {
    const anaCode = await codeOf(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(anaCode)
    await beto.page.getByTestId('send-hello').click()
    await acceptRequest(ana)
    await openConversation(ana)
    await openConversation(beto)

    // Con los dos conectados, la cabecera dice el camino (y no «desconectado»).
    const route = beto.page.getByTestId('route')
    await expect(route).not.toHaveAttribute('data-route', 'offline', { timeout: WAIT })
    console.log('route:', await route.getAttribute('data-route'), '·', (await route.textContent()).trim())
    if (process.env.SHOT) {
      await beto.page.screenshot({ path: process.env.SHOT + '-desk.png' })
      await beto.page.setViewportSize({ width: 390, height: 800 })
      await beto.page.screenshot({ path: process.env.SHOT + '-movil.png' })
      await beto.page.setViewportSize({ width: 1280, height: 900 })
    }

    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 256))
    await beto.page.getByTestId('file-input').setInputFiles({ name: 'informe final.pdf', mimeType: 'application/pdf', buffer: bytes })
    const fileCard = ana.page.getByTestId('msg-in').getByTestId('msg-file')
    await expect(fileCard.getByTestId('msg-file-name')).toHaveText('informe final.pdf', { timeout: WAIT })
    const [download] = await Promise.all([
      ana.page.waitForEvent('download'),
      fileCard.getByTestId('msg-file-download').click()
    ])
    expect(download.suggestedFilename()).toBe('informe final.pdf')
    const downloadPath = await download.path()
    const fs2 = await import('node:fs')
    expect(Buffer.compare(fs2.readFileSync(downloadPath), bytes), 'se descargan los mismos bytes').toBe(0)
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

/**
 * EL TOPE SE DICE: con el contacto desconectado, un archivo de más de 8 MB no se queda en el
 * proxio. Se avisa al intentarlo y la burbuja dice que espera a que se conecte.
 */
test('un archivo grande para alguien desconectado avisa del tope y espera', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await enter(browser, `Ana${runTag}T`)
  const beto = await enter(browser, `Beto${runTag}T`)
  try {
    const anaCode = await codeOf(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(anaCode)
    await beto.page.getByTestId('send-hello').click()
    await acceptRequest(ana)
    await openConversation(ana)
    await openConversation(beto)
    await sendText(beto, `before ${runTag}`)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: `before ${runTag}` })).toBeVisible({ timeout: WAIT })
    await ana.page.close()
    await expect(beto.page.getByTestId('route')).toHaveAttribute('data-route', 'offline', { timeout: WAIT })

    await beto.page.getByTestId('file-input').setInputFiles({ name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(9 * 1024 * 1024, 7) })
    await expect(beto.page.getByTestId('file-notice')).toContainText('8', { timeout: WAIT })
    await expect(beto.page.getByTestId('msg-out').getByTestId('msg-waits')).toHaveAttribute('data-waits', 'online', { timeout: WAIT })
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

/**
 * BLOQUEAR (indicador privado de la tarjeta, aparte de las estrellas): lo que manda alguien
 * bloqueado no llega, y al desbloquear vuelve a llegar. Se bloquea DESDE LA TARJETA, como lo
 * haría una persona.
 */
test('lo de alguien bloqueado no llega; al desbloquear, sí', async () => {
  test.setTimeout(240_000)
  const browser = await chromium.launch()
  const ana = await enter(browser, `Ana${runTag}B`)
  const beto = await enter(browser, `Beto${runTag}B`)
  try {
    const anaCode = await codeOf(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(anaCode)
    await beto.page.getByTestId('send-hello').click()
    await acceptRequest(ana)
    await openConversation(ana)
    await openConversation(beto)

    // Antes de bloquear, llega: si no, la prueba no prueba nada.
    const before = `before ${runTag}`
    await sendText(beto, before)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: before })).toBeVisible({ timeout: WAIT })

    // Ana lo bloquea desde la tarjeta.
    await ana.page.getByTestId('rate-contact').click()
    const toggle = ana.page.locator('dotrino-profile').getByTestId('profile-block-toggle')
    await toggle.waitFor({ timeout: WAIT })
    await toggle.click()
    await expect(ana.page.locator('dotrino-profile').getByTestId('profile-block')).toHaveClass(/\bon\b/, { timeout: WAIT })
    await ana.page.keyboard.press('Escape')
    await expect(ana.page.getByTestId('contact-blocked')).toBeVisible({ timeout: WAIT })

    const blocked = `blocked ${runTag}`
    await sendText(beto, blocked)
    await ana.page.waitForTimeout(15_000)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: blocked })).toHaveCount(0)

    // Desbloquea, y lo siguiente vuelve a llegar.
    await ana.page.getByTestId('rate-contact').click()
    await toggle.waitFor({ timeout: WAIT })
    await toggle.click()
    await expect(ana.page.locator('dotrino-profile').getByTestId('profile-block')).not.toHaveClass(/\bon\b/, { timeout: WAIT })
    await ana.page.keyboard.press('Escape')
    const after = `after ${runTag}`
    await sendText(beto, after)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: after })).toBeVisible({ timeout: WAIT })
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

test('tocar el código de la barra abre «Mi código» con el mismo código y su QR', async () => {
  test.setTimeout(120_000)
  const browser = await chromium.launch()
  const ana = await enter(browser, `Ana${runTag}C`)
  try {
    const pairCode = await codeOf(ana)
    await ana.page.getByTestId('my-code').click()
    await expect(ana.page.getByTestId('my-pairing-code')).toHaveText(pairCode, { timeout: WAIT })
    await expect(ana.page.getByTestId('my-qr')).toBeVisible()
    // Y el «+» sigue abriendo la pestaña de agregar por código.
    await ana.page.getByTestId('close-add').click()
    await ana.page.getByTestId('add-contact').click()
    await expect(ana.page.getByTestId('code-input')).toBeVisible()
  } finally {
    await ana.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

test('una amiga entra escaneando el QR del otro', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await enter(browser, `Ana${runTag}Q`)
  const carla = await enter(browser, `Carla${runTag}`)
  const png = path.join(os.tmpdir(), `dotrino-qr-${runTag}.png`)

  try {
    await codeOf(ana)

    // 1) Ana enseña su QR. Se guarda la imagen para dársela al escáner: es la
    //    misma que vería una cámara apuntando a la pantalla, sin cámara de por medio.
    await ana.page.getByTestId('add-contact').click()
    await ana.page.getByTestId('share-my-token-tab').click()
    const qr = ana.page.getByTestId('my-qr')
    await qr.waitFor({ timeout: WAIT })
    await qr.screenshot({ path: png })
    expect(fs.statSync(png).size, 'la captura del QR salió vacía').toBeGreaterThan(0)
    await ana.page.getByTestId('close-add').click()

    // 2) Carla abre el escáner y le da la foto. El input vive en el Shadow DOM de
    //    <dotrino-qr-scan>; Playwright lo atraviesa solo.
    await carla.page.getByTestId('add-contact').click()
    await carla.page.getByTestId('scan-qr').click()
    const file = carla.page.locator('dotrino-qr-scan input[type=file]')
    await file.waitFor({ state: 'attached', timeout: WAIT })
    await file.setInputFiles(png)

    // 3) De ahí sale el saludo sin teclear nada: a Ana le llega la solicitud.
    await acceptRequest(ana)

    // 4) Y conversan, que es la prueba de que el emparejamiento fue real.
    const fromCarla = `vengo por el QR ${runTag}`
    await openConversation(carla)
    await sendText(carla, fromCarla)
    await openConversation(ana)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: fromCarla }))
      .toBeVisible({ timeout: WAIT })
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
  const ana = await enter(browser, `Ana${runTag}L`)
  let dani = null

  try {
    const pairCode = await codeOf(ana)

    // Quien apunta la cámara del sistema al QR no entra a la app: entra al ENLACE
    // que lleva dentro. Ese camino tiene que dejar el código escrito, o la persona
    // acaba tecleando lo mismo que acaba de escanear.
    dani = await enter(browser, `Dani${runTag}`)
    await dani.page.goto(`${SITE}#add=${pairCode}`, { waitUntil: 'domcontentloaded' })

    const input = dani.page.getByTestId('code-input')
    await input.waitFor({ timeout: WAIT })
    await expect(input).toHaveValue(pairCode)
    // Y el enlace se limpia: recargar no reintenta un código ya quemado.
    expect(await dani.page.evaluate(() => location.hash)).toBe('')

    await dani.page.getByTestId('send-hello').click()
    await acceptRequest(ana)
  } finally {
    await ana.context.close().catch(() => {})
    if (dani) await dani.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})
