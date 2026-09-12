import { test, expect, chromium } from '@playwright/test'

/**
 * EL TEXTO LLEGA TAL CUAL, Y SIGUE SIENDO TEXTO.
 *
 * Dos cosas que tiran la una de la otra, y por eso se prueban juntas:
 *
 *  1. Lo que escribe uno es EXACTAMENTE lo que lee el otro. Un enlace con
 *     parámetros (`?x=1&y=2`) es el caso que lo destapó: el `&` llegaba como
 *     `&amp;` y el enlace quedaba roto. Y un `#fragment` no puede alterarse
 *     nunca: en Dotrino ahí viaja contenido del usuario.
 *  2. Ese texto NO se interpreta como HTML. Que el `&` viaje intacto no
 *     puede significar que un `<img onerror=…>` se ejecute en la pantalla
 *     del otro.
 *
 *   npx playwright test tests/texto-literal.spec.js            (contra producción)
 *   SITE_URL=http://localhost:4173 npx playwright test tests/texto-literal.spec.js
 */
const SITE = process.env.SITE_URL || 'https://messenger.dotrino.com'
const CODE_RE = /^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$/
const ESPERA = 45_000

const marca = Math.random().toString(36).slice(2, 6).toUpperCase()

async function entrar (browser, apodo) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => {
    for (const id of ['profile', 'token', 'add', 'share', 'contacts', 'compose']) {
      try { localStorage.setItem(`messenger.tutorial:seen:${id}`, '1') } catch (_) {}
    }
    // Testigo de ejecución: si el HTML del mensaje se interpreta, esto se pone a 1.
    window.__xssRan = 0
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

/** El texto pintado en la burbuja número `n` (0-based) del lado indicado. */
async function burbuja (amigo, dir, n) {
  const b = amigo.page.getByTestId(`msg-${dir}`).nth(n).getByTestId('msg-text')
  await b.waitFor({ timeout: ESPERA })
  return b.textContent()
}

async function emparejar (browser) {
  const ana = await entrar(browser, `Ana${marca}T`)
  const beto = await entrar(browser, `Beto${marca}T`)
  const codigoAna = await codigoDe(ana)
  await beto.page.getByTestId('add-contact').click()
  await beto.page.getByTestId('code-input').fill(codigoAna)
  await beto.page.getByTestId('send-hello').click()
  await aceptarSolicitud(ana)
  await abrirConversacion(ana)
  await abrirConversacion(beto)
  return { ana, beto }
}

test('el mensaje llega letra por letra, y sigue siendo texto', async () => {
  test.setTimeout(240_000)
  const browser = await chromium.launch()
  const { ana, beto } = await emparejar(browser)

  // Cada uno es un caso distinto del mismo sitio: el escapado de HTML.
  const casos = [
    // El que lo destapó: un enlace con parámetros. El `&` separa, no adorna.
    `https://ejemplo.com/a?x=1&y=2&z=a+b ${marca}`,
    // Un `#fragment`: en Dotrino ahí viaja contenido del usuario y no puede alterarse.
    `https://eco.dotrino.com/#ow=abc&cid=def%2Fghi ${marca}`,
    // Los vecinos del mismo escapado, sueltos y mezclados con texto.
    `3 < 5 > 1 & "comillas" 'simples' & suelto ${marca}`,
    // Mezcla de prosa y enlace, que es como se manda de verdad.
    `mira esto: https://x.com/q?a=1&b=2 & luego me cuentas ${marca}`,
    // Y el que NO se puede ejecutar por mucho que viaje intacto.
    `<img src=x onerror="window.__xssRan=1"> <script>window.__xssRan=1</script> ${marca}`,
  ]

  try {
    for (let i = 0; i < casos.length; i++) {
      const enviado = casos[i]
      await escribir(beto, enviado)

      // 1) Lo que ve QUIEN RECIBE: exactamente lo que se escribió.
      await expect.poll(() => burbuja(ana, 'in', i), {
        timeout: ESPERA,
        message: `el mensaje ${i} llegó alterado`,
      }).toBe(enviado)

      // 2) Lo que ve QUIEN ENVÍA, en su propia burbuja: lo mismo. Si el emisor
      //    corrompe el dato antes de mandarlo, esto se cae aquí y no allá.
      expect(await burbuja(beto, 'out', i), `el mensaje ${i} se guardó alterado en el emisor`).toBe(enviado)
    }

    // 3) Nada de ese HTML llegó a interpretarse: ni se ejecutó nada, ni se
    //    materializó ningún elemento dentro de una burbuja.
    for (const amigo of [ana, beto]) {
      expect(await amigo.page.evaluate(() => window.__xssRan), `se ejecutó HTML del mensaje en ${amigo.apodo}`).toBe(0)
      expect(await amigo.page.locator('[data-testid^=msg-] img, [data-testid^=msg-] script').count(),
        `el HTML del mensaje se convirtió en elementos en ${amigo.apodo}`).toBe(0)
    }
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})
