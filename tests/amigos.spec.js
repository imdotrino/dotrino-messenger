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

async function entrar (browser, apodo, { proxy } = {}) {
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
  page.on('pageerror', (e) => console.log(`[${apodo}] PAGEERROR`, e.message))
  if (process.env.DEBUG_CONSOLE) page.on('console', (m) => { if (/cc-conn|messenger|part|queue|WS error|error/i.test(m.text())) console.log(`[${apodo}]`, m.text().slice(0, 200)) })
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

    // 2) Beto la agrega con ese código: le manda una SOLICITUD, no un mensaje.
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(codigoAna)
    await beto.page.getByTestId('send-hello').click()

    // 3) A Ana le llega la solicitud. Es un mensaje de control entre los dos: en
    //    ningún chat de Ana aparece nada, y nadie es contacto de nadie todavía.
    await ana.page.getByTestId('accept-request').first().waitFor({ timeout: ESPERA })
    await expect(ana.page.getByTestId('msg-in')).toHaveCount(0)
    // Nadie es contacto de nadie… salvo Dotrino, que está siempre y no se puede quitar.
    await expect(ana.page.getByTestId('contact-dotrino')).toHaveCount(1, { timeout: ESPERA })
    await expect(ana.page.getByTestId('contact-item')).toHaveCount(0)
    await expect(beto.page.getByTestId('contact-item')).toHaveCount(0)
    await aceptarSolicitud(ana)

    // 4) El código es de un solo uso: en cuanto alguien lo gasta, la barra tiene
    //    que enseñar otro. Si no, el siguiente amigo teclea uno muerto.
    await expect.poll(async () => (await ana.page.getByTestId('my-code').textContent()).trim(),
      { timeout: ESPERA, message: 'el código gastado se quedó en pantalla' })
      .not.toBe(codigoAna)

    // 5) Beto la ve en sus contactos cuando ella acepta (no antes), y se escriben.
    //    Ningún chat empezó con un mensaje de la solicitud.
    await abrirConversacion(ana)
    await expect(ana.page.getByTestId('msg-in')).toHaveCount(0)
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

/**
 * FOTOS: la imagen sale TAL CUAL (no se toca el contenido del usuario), en partes por el
 * transporte, y la otra punta recibe los mismos bytes. Y no se pierde al recargar.
 */
test('un amigo le manda una foto al otro, byte a byte', async () => {
  test.setTimeout(180_000)
  const browser = await chromium.launch()
  const ana = await entrar(browser, `Ana${marca}F`)
  const beto = await entrar(browser, `Beto${marca}F`)
  try {
    const codigoAna = await codigoDe(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(codigoAna)
    await beto.page.getByTestId('send-hello').click()
    await aceptarSolicitud(ana)
    await abrirConversacion(ana)
    await abrirConversacion(beto)

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
    const pie = `mira esto ${marca}`
    await beto.page.getByTestId('composer-input').fill(pie)
    const t0 = Date.now()
    await beto.page.getByTestId('file-input').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })

    const recibida = ana.page.getByTestId('msg-in').filter({ hasText: pie })
    const img = recibida.getByTestId('msg-image').locator('img')
    await expect(img).toBeVisible({ timeout: ESPERA })
    console.log(`foto de ${(png.length * 0.75 / 1048576).toFixed(1)} MB entregada en ${((Date.now() - t0) / 1000).toFixed(1)} s`)
    expect(await img.getAttribute('src'), 'llegan los mismos bytes, sin recomprimir').toBe(`data:image/png;base64,${png}`)

    // Quien la mandó la ve con el acuse (✓), y la foto sigue ahí al recargar.
    await expect(beto.page.getByTestId('msg-out').filter({ hasText: pie }).locator('.check')).toHaveText('✓', { timeout: ESPERA })
    await ana.page.reload()
    await abrirConversacion(ana)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: pie }).getByTestId('msg-image')).toBeVisible({ timeout: ESPERA })
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
  const ana = await entrar(browser, `Ana${marca}O`, { proxy: 'wss://proxy.dotrino.com' })
  const beto = await entrar(browser, `Beto${marca}O`, { proxy: 'wss://proxy2.dotrino.com' })
  try {
    const codigoAna = await codigoDe(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(codigoAna)
    await beto.page.getByTestId('send-hello').click()
    await aceptarSolicitud(ana)
    await abrirConversacion(ana)
    await abrirConversacion(beto)
    // Que se hayan visto una vez (un texto de ida), y Ana cierra la app.
    await escribir(beto, `antes ${marca}`)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: `antes ${marca}` })).toBeVisible({ timeout: ESPERA })
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
    const pie = `mientras no estabas ${marca}`
    await beto.page.getByTestId('composer-input').fill(pie)
    await beto.page.getByTestId('file-input').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    await beto.page.waitForTimeout(5000)

    // Ana vuelve: la cola del proxio le entrega la foto entera.
    ana.page = await ana.context.newPage()
    await ana.page.goto(SITE, { waitUntil: 'domcontentloaded' })
    await abrirConversacion(ana)
    const img = ana.page.getByTestId('msg-in').filter({ hasText: pie }).getByTestId('msg-image').locator('img')
    await expect(img).toBeVisible({ timeout: ESPERA })
    console.log(`foto de ${(png.length * 0.75 / 1048576).toFixed(1)} MB entregada desde la cola`)
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
  const ana = await entrar(browser, `Ana${marca}P`)
  const beto = await entrar(browser, `Beto${marca}P`)
  try {
    const codigoAna = await codigoDe(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(codigoAna)
    await beto.page.getByTestId('send-hello').click()
    await aceptarSolicitud(ana)
    await abrirConversacion(ana)
    await abrirConversacion(beto)

    // Con los dos conectados, la cabecera dice el camino (y no «desconectado»).
    const ruta = beto.page.getByTestId('route')
    await expect(ruta).not.toHaveAttribute('data-route', 'offline', { timeout: ESPERA })
    console.log('camino:', await ruta.getAttribute('data-route'), '·', (await ruta.textContent()).trim())
    if (process.env.SHOT) {
      await beto.page.screenshot({ path: process.env.SHOT + '-desk.png' })
      await beto.page.setViewportSize({ width: 390, height: 800 })
      await beto.page.screenshot({ path: process.env.SHOT + '-movil.png' })
      await beto.page.setViewportSize({ width: 1280, height: 900 })
    }

    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 31) % 256))
    await beto.page.getByTestId('file-input').setInputFiles({ name: 'informe final.pdf', mimeType: 'application/pdf', buffer: bytes })
    const ficha = ana.page.getByTestId('msg-in').getByTestId('msg-file')
    await expect(ficha.getByTestId('msg-file-name')).toHaveText('informe final.pdf', { timeout: ESPERA })
    const [descarga] = await Promise.all([
      ana.page.waitForEvent('download'),
      ficha.getByTestId('msg-file-download').click()
    ])
    expect(descarga.suggestedFilename()).toBe('informe final.pdf')
    const ruta2 = await descarga.path()
    const fs2 = await import('node:fs')
    expect(Buffer.compare(fs2.readFileSync(ruta2), bytes), 'se descargan los mismos bytes').toBe(0)
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
  const ana = await entrar(browser, `Ana${marca}T`)
  const beto = await entrar(browser, `Beto${marca}T`)
  try {
    const codigoAna = await codigoDe(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(codigoAna)
    await beto.page.getByTestId('send-hello').click()
    await aceptarSolicitud(ana)
    await abrirConversacion(ana)
    await abrirConversacion(beto)
    await escribir(beto, `antes ${marca}`)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: `antes ${marca}` })).toBeVisible({ timeout: ESPERA })
    await ana.page.close()
    await expect(beto.page.getByTestId('route')).toHaveAttribute('data-route', 'offline', { timeout: ESPERA })

    await beto.page.getByTestId('file-input').setInputFiles({ name: 'video.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(9 * 1024 * 1024, 7) })
    await expect(beto.page.getByTestId('file-notice')).toContainText('8', { timeout: ESPERA })
    await expect(beto.page.getByTestId('msg-out').getByTestId('msg-waits')).toHaveAttribute('data-waits', 'online', { timeout: ESPERA })
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
  const ana = await entrar(browser, `Ana${marca}B`)
  const beto = await entrar(browser, `Beto${marca}B`)
  try {
    const codigoAna = await codigoDe(ana)
    await beto.page.getByTestId('add-contact').click()
    await beto.page.getByTestId('code-input').fill(codigoAna)
    await beto.page.getByTestId('send-hello').click()
    await aceptarSolicitud(ana)
    await abrirConversacion(ana)
    await abrirConversacion(beto)

    // Antes de bloquear, llega: si no, la prueba no prueba nada.
    const antes = `antes ${marca}`
    await escribir(beto, antes)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: antes })).toBeVisible({ timeout: ESPERA })

    // Ana lo bloquea desde la tarjeta.
    await ana.page.getByTestId('rate-contact').click()
    const toggle = ana.page.locator('dotrino-profile').getByTestId('profile-block-toggle')
    await toggle.waitFor({ timeout: ESPERA })
    await toggle.click()
    await expect(ana.page.locator('dotrino-profile').getByTestId('profile-block')).toHaveClass(/\bon\b/, { timeout: ESPERA })
    await ana.page.keyboard.press('Escape')
    await expect(ana.page.getByTestId('contact-blocked')).toBeVisible({ timeout: ESPERA })

    const bloqueado = `bloqueado ${marca}`
    await escribir(beto, bloqueado)
    await ana.page.waitForTimeout(15_000)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: bloqueado })).toHaveCount(0)

    // Desbloquea, y lo siguiente vuelve a llegar.
    await ana.page.getByTestId('rate-contact').click()
    await toggle.waitFor({ timeout: ESPERA })
    await toggle.click()
    await expect(ana.page.locator('dotrino-profile').getByTestId('profile-block')).not.toHaveClass(/\bon\b/, { timeout: ESPERA })
    await ana.page.keyboard.press('Escape')
    const despues = `despues ${marca}`
    await escribir(beto, despues)
    await expect(ana.page.getByTestId('msg-in').filter({ hasText: despues })).toBeVisible({ timeout: ESPERA })
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})

test('tocar el código de la barra abre «Mi código» con el mismo código y su QR', async () => {
  test.setTimeout(120_000)
  const browser = await chromium.launch()
  const ana = await entrar(browser, `Ana${marca}C`)
  try {
    const codigo = await codigoDe(ana)
    await ana.page.getByTestId('my-code').click()
    await expect(ana.page.getByTestId('my-pairing-code')).toHaveText(codigo, { timeout: ESPERA })
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
    await ana.page.getByTestId('close-add').click()

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
