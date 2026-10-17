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
 *   npx playwright test tests/literal-text.spec.js            (contra producción)
 *   SITE_URL=http://localhost:4173 npx playwright test tests/literal-text.spec.js
 */
const SITE = process.env.SITE_URL || 'https://messenger.dotrino.com'
const CODE_RE = /^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$/
const WAIT = 45_000

const runTag = Math.random().toString(36).slice(2, 6).toUpperCase()

async function enter (browser, nickname) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.addInitScript(() => {
    for (const id of ['profile', 'token', 'add', 'share', 'contacts', 'compose']) {
      try { localStorage.setItem(`messenger.tutorial:seen:${id}`, '1') } catch (_) {}
    }
    // Testigo de ejecución: si el HTML del mensaje se interpreta, esto se pone a 1.
    window.__xssRan = 0
  })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log(`[${nickname}] PAGEERROR`, e.message))
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  const nick = page.getByTestId('nickname-input')
  await nick.waitFor({ timeout: WAIT })
  await nick.fill(nickname)
  await page.getByTestId('nickname-submit').click()
  return { context, page, nickname }
}

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

/** El texto pintado en la burbuja número `n` (0-based) del lado indicado. */
async function bubbleText (friend, dir, n) {
  const b = friend.page.getByTestId(`msg-${dir}`).nth(n).getByTestId('msg-text')
  await b.waitFor({ timeout: WAIT })
  return b.textContent()
}

async function pair (browser) {
  const ana = await enter(browser, `Ana${runTag}T`)
  const beto = await enter(browser, `Beto${runTag}T`)
  const anaCode = await codeOf(ana)
  await beto.page.getByTestId('add-contact').click()
  await beto.page.getByTestId('code-input').fill(anaCode)
  await beto.page.getByTestId('send-hello').click()
  await acceptRequest(ana)
  await openConversation(ana)
  await openConversation(beto)
  return { ana, beto }
}

test('el mensaje llega letra por letra, y sigue siendo texto', async () => {
  test.setTimeout(240_000)
  const browser = await chromium.launch()
  const { ana, beto } = await pair(browser)

  // Cada uno es un caso distinto del mismo sitio: el escapado de HTML.
  const cases = [
    // El que lo destapó: un enlace con parámetros. El `&` separa, no adorna.
    `https://ejemplo.com/a?x=1&y=2&z=a+b ${runTag}`,
    // Un `#fragment`: en Dotrino ahí viaja contenido del usuario y no puede alterarse.
    `https://eco.dotrino.com/#ow=abc&cid=def%2Fghi ${runTag}`,
    // Los vecinos del mismo escapado, sueltos y mezclados con texto.
    `3 < 5 > 1 & "comillas" 'simples' & suelto ${runTag}`,
    // Mezcla de prosa y enlace, que es como se manda de verdad.
    `mira esto: https://x.com/q?a=1&b=2 & luego me cuentas ${runTag}`,
    // Y el que NO se puede ejecutar por mucho que viaje intacto.
    `<img src=x onerror="window.__xssRan=1"> <script>window.__xssRan=1</script> ${runTag}`,
  ]

  try {
    for (let i = 0; i < cases.length; i++) {
      const sent = cases[i]
      await sendText(beto, sent)

      // 1) Lo que ve QUIEN RECIBE: exactamente lo que se escribió.
      await expect.poll(() => bubbleText(ana, 'in', i), {
        timeout: WAIT,
        message: `el mensaje ${i} llegó alterado`,
      }).toBe(sent)

      // 2) Lo que ve QUIEN ENVÍA, en su propia burbuja: lo mismo. Si el emisor
      //    corrompe el dato antes de mandarlo, esto se cae aquí y no allá.
      expect(await bubbleText(beto, 'out', i), `el mensaje ${i} se guardó alterado en el emisor`).toBe(sent)
    }

    // 3) Nada de ese HTML llegó a interpretarse: ni se ejecutó nada, ni se
    //    materializó ningún elemento dentro de una burbuja.
    for (const friend of [ana, beto]) {
      expect(await friend.page.evaluate(() => window.__xssRan), `se ejecutó HTML del mensaje en ${friend.nickname}`).toBe(0)
      expect(await friend.page.locator('[data-testid^=msg-] img, [data-testid^=msg-] script').count(),
        `el HTML del mensaje se convirtió en elementos en ${friend.nickname}`).toBe(0)
    }
  } finally {
    await ana.context.close().catch(() => {})
    await beto.context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
})
