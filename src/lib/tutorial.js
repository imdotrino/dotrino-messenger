// Tutorial guiado del Messenger (burbujas tipo donar/compartir) con el paquete
// compartido @dotrino/tutorial. Explica tu IDENTIDAD/perfil, tu
// CÓDIGO de emparejamiento (para que te agreguen), cómo AÑADIR un contacto, cómo
// COMPARTIR tu código y cómo CONVERSAR. La app no tiene menú burger: en móvil la
// barra de contactos se muestra con setSidebarMobile(true). Los pasos que
// requieren contactos/conversación se gatean con skipIf y aparecen cuando existen.
import { createTutorial } from '@dotrino/tutorial'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let instance = null

export function startAppTutorial (ctx) {
  if (instance) return instance

  const showSide = async () => { ctx.setSidebarMobile(true); await sleep(300) }

  // El paso 'profile' apunta a un elemento del SHADOW DOM del <dotrino-topbar>.
  // Eso obligaba a apagar el chequeo de oclusión entero (no-occlusion-check),
  // porque el paquete lo hacía con document.elementFromPoint(), que no atraviesa
  // shadow DOM. Arreglado en @dotrino/tutorial 0.2.0 (deepElementFromPoint +
  // composedContains), así que el chequeo vuelve a estar activo para TODOS los
  // pasos, también los del light DOM.
  const el = document.createElement('dotrino-tutorial')
  document.body.appendChild(el)

  instance = createTutorial({
    element: el,
    lang: ctx.lang(),
    storageKey: 'messenger.tutorial',
    startDelay: 1000,
    stepTimeout: 5000,
    steps: [
      {
        id: 'profile', order: 1, placement: 'bottom',
        // El botón de perfil vive en el SHADOW DOM de <dotrino-topbar>, así que un
        // selector plano (document.querySelector) no lo encuentra y el paso se
        // saltaría en silencio. El paquete acepta una función como target: la
        // usamos para entrar al shadow root.
        target: () => document.querySelector('dotrino-topbar')?.shadowRoot
          ?.querySelector('[data-testid="my-profile"]') || null,
        title: { es: 'Tu identidad', en: 'Your identity' },
        text: {
          es: 'Este es tu perfil: tu apodo y tu clave criptográfica viven en tu bóveda. Tócalo para ver y editar quién eres, y respaldar tu identidad.',
          en: 'This is your profile: your nickname and your key live in your vault. Tap it to view and edit who you are, and back up your identity.',
        },
      },
      {
        id: 'token', order: 2, placement: 'bottom',
        target: '[data-testid="my-code"]',
        title: { es: 'Tu código', en: 'Your code' },
        text: {
          es: 'Este es tu código para que te agreguen: 6 caracteres que puedes dictar por teléfono. Tócalo para copiarlo. Vale para una sola persona y caduca a los pocos minutos; se renueva solo.',
          en: 'This is your code for people to add you: 6 characters you can read out over the phone. Tap it to copy. It works for one person only and expires after a few minutes; it renews itself.',
        },
      },
      {
        id: 'add', order: 3, placement: 'bottom',
        target: '[data-testid="add-contact"]',
        before: showSide,
        title: { es: 'Agregar un contacto', en: 'Add a contact' },
        text: {
          es: 'Con este botón + agregas un contacto: escribe su código de 6 caracteres o escanea su QR, y le enviamos un saludo cifrado. Cuando responda, aparece en tu lista.',
          en: 'This + button adds a contact: type their 6-character code or scan their QR, and we send an encrypted hello. When they reply, they appear in your list.',
        },
      },
      {
        id: 'share', order: 4, placement: 'bottom',
        target: '[data-testid="share-my-token-tab"]',
        before: async () => { ctx.openAdd(true); await sleep(300) },
        title: { es: 'Compartir tu código', en: 'Share your code' },
        text: {
          es: 'Aquí compartes TU código: abre "Mi código" y enséñale el QR a quien tengas al lado, o cópialo para mandárselo. Así te encuentran y te escriben.',
          en: 'Here you share YOUR code: open "My code" and show the QR to whoever is next to you, or copy it and send it. That is how they find and message you.',
        },
      },
      {
        id: 'contacts', order: 5, placement: 'right',
        target: '[data-testid="contact-item"]',
        skipIf: () => !ctx.hasContact(),
        before: async () => { ctx.openAdd(false); await showSide() },
        title: { es: 'Tus contactos', en: 'Your contacts' },
        text: {
          es: 'Tus contactos aparecen aquí. Toca uno para abrir la conversación.',
          en: 'Your contacts show up here. Tap one to open the conversation.',
        },
      },
      {
        id: 'compose', order: 6, placement: 'top',
        target: '[data-testid="composer-input"]',
        skipIf: () => !ctx.hasContact(),
        before: async () => { ctx.openAdd(false); ctx.openConvo(); await sleep(250) },
        title: { es: 'Escribir y enviar', en: 'Write and send' },
        text: {
          es: 'Aquí escribes y envías tus mensajes. Van cifrados de extremo a extremo; si tu contacto está desconectado, quedan en cola hasta 24 horas.',
          en: 'Here you write and send your messages. They are end-to-end encrypted; if your contact is offline, they queue for up to 24 hours.',
        },
      },
    ],
  })

  // Al terminar (o saltar), cerramos el modal de "añadir contacto" por si quedó
  // abierto en el paso de compartir el token.
  instance.addEventListener('cc-tutorial-done', () => ctx.openAdd(false))
  return instance
}
