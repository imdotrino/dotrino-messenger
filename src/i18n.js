// Bilingüe es/en (CONVENCIONES §9). Español neutro / tuteo, SIN voseo.
// Lenguaje llano (§9.1): contamos el beneficio, no cómo está hecho por dentro.
//
// El idioma lo MANDA <dotrino-topbar> (§5): él pinta el toggle ES/EN, lo persiste
// en localStorage 'dotrino.lang' y avisa con el evento 'dotrino-lang'. Esta app no
// tiene toggle propio ni clave propia: solo escucha y replica. `detectLang()`
// existe para arrancar con el MISMO idioma que resolverá el topbar, antes de que
// el componente monte (evita un parpadeo del copy).
import { ref, computed } from 'vue'

export const LANG_KEY = 'dotrino.lang'

export function detectLang () {
  try {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved === 'es' || saved === 'en') return saved
  } catch (_) {}
  try {
    return (navigator.language || 'es').toLowerCase().startsWith('en') ? 'en' : 'es'
  } catch (_) {}
  return 'es'
}

export const lang = ref(detectLang())

/** Lo llama App.vue al recibir 'dotrino-lang' del topbar. */
export function setLang (l) {
  if (l === 'es' || l === 'en') lang.value = l
}

/** Textos del idioma activo: en el template, `{{ t.foo.bar }}`. */
export const t = computed(() => messages[lang.value])

/** Locale para fechas/horas (nombres de día y mes visibles en la lista). */
export const locale = computed(() => (lang.value === 'en' ? 'en-US' : 'es-EC'))

export const messages = {
  es: {
    boot: { loading: 'Cargando…' },

    // Overlay de la extensión: aquí no se puede crear la cuenta, se manda al
    // messenger real. Sin jerga: nada de "iframe", "storage particionado" ni
    // "APIs criptográficas" — solo qué hacer.
    login: {
      title: 'Inicia sesión',
      insecure: 'La página donde estás no usa una conexión segura, así que tu cuenta no puede abrirse aquí dentro. Ábrela en su propia pestaña.',
      intro: 'Crea tu cuenta o entra en messenger.dotrino.com. Se sincroniza sola con la extensión.',
      button: 'Entrar',
    },

    topbar: { bell: 'Notificaciones y solicitudes' },

    sidebar: { title: 'Contactos', add: 'Añadir contacto' },

    // El "+" va en negrita entre las dos mitades del texto.
    empty: {
      title: 'Selecciona un contacto',
      before: 'Para empezar una conversación, elige a alguien de la lista, o pulsa',
      after: 'para añadir un contacto nuevo con su token.',
    },

    welcome: {
      tagline: 'Mensajes privados, de tú a tú',
      intro: 'Antes de empezar, dinos cómo te ven los demás.',
      label: 'Tu apodo',
      placeholder: 'ej. alicia_2024',
      helper: 'Puedes cambiarlo cuando quieras. No es único: quien te identifica de verdad es la llave que se queda en tu dispositivo.',
      submit: 'Continuar',
      info: 'Tu identidad se crea aquí mismo, en tu navegador. La llave que te identifica nunca sale de tu dispositivo.',
      link: '¿Cómo funciona la identidad? →',
    },

    add: {
      title: 'Añadir contacto',
      close: 'Cerrar',
      tabAdd: '🔗 Por token',
      tabMine: '📤 Mi token',
      info: 'Pega aquí el token que te compartió tu contacto. En el primer mensaje comprobamos que de verdad sea esa persona.',
      fieldToken: 'Token del contacto',
      phToken: 'ej. A4F2',
      paste: 'Pegar',
      fieldAlias: 'Apodo (opcional)',
      phAlias: 'ej. Bob de chess',
      hint: 'Le enviaremos un saludo cifrado con tu identidad. Cuando responda, aparecerá en tu lista automáticamente.',
      mineInfo: 'Comparte este token con tu contacto. Cambia cada vez que te conectas, pero tu identidad sigue siendo la misma.',
      copy: 'Copiar',
      cancel: 'Cancelar',
      send: 'Enviar saludo',
      done: 'Listo',
      errInvalid: 'Token inválido (4-8 caracteres alfanuméricos en mayúsculas).',
      errOwn: 'Ese es tu propio token.',
      errSend: 'No se pudo enviar el saludo.',
    },

    list: {
      emptyBefore: 'Aún no tienes contactos.',
      emptyPress: 'Pulsa',
      emptyAfter: 'para añadir uno.',
      rate: 'Calificar',
      noMessages: 'Sin mensajes',
      ratingMine: 'Tu calificación',
      ratingDerived: 'Calificación estimada a partir de tu red de confianza',
    },

    conv: {
      back: 'Volver',
      rate: 'Calificar',
      online: 'en línea',
      offline: 'sin conexión · los mensajes esperan',
      emptyBig: 'Aún no hay mensajes',
      emptySmall: 'Saluda y empieza la conversación 👋',
      today: 'Hoy',
      yesterday: 'Ayer',
      attach: 'Adjuntar (próximamente)',
      placeholder: 'Escribe un mensaje…',
      send: 'Enviar',
    },

    requests: {
      title: 'Solicitudes de contacto',
      empty: 'No tienes solicitudes pendientes.',
      vouched: 'avalado por tu red',
      vouchedTitle: 'Avalado por tu red de confianza',
      stranger: 'desconocido',
      strangerTitle: 'Desconocido: nadie de tu red lo avala',
      defaultMsg: 'Quiere agregarte como contacto',
      accept: 'Aceptar y agregar a contactos',
      dismiss: 'Descartar',
    },

    incoming: { newMessage: 'Mensaje nuevo' },

    // Apodo de emergencia cuando el overlay no trae uno (se ve como "@Yo").
    fallbackNick: 'Yo',
  },

  en: {
    boot: { loading: 'Loading…' },

    login: {
      title: 'Sign in',
      insecure: 'The page you are on does not use a secure connection, so your account cannot open in here. Open it in its own tab.',
      intro: 'Create your account or sign in at messenger.dotrino.com. It syncs with the extension on its own.',
      button: 'Log in',
    },

    topbar: { bell: 'Notifications and requests' },

    sidebar: { title: 'Contacts', add: 'Add contact' },

    empty: {
      title: 'Pick a contact',
      before: 'To start a conversation, choose someone from the list, or press',
      after: 'to add a new contact with their token.',
    },

    welcome: {
      tagline: 'Private one-to-one messages',
      intro: 'Before we start, tell us how others will see you.',
      label: 'Your nickname',
      placeholder: 'e.g. alice_2024',
      helper: 'You can change it any time. It is not unique — what really identifies you is the key that stays on your device.',
      submit: 'Continue',
      info: 'Your identity is created right here, in your browser. The key that identifies you never leaves your device.',
      link: 'How does identity work? →',
    },

    add: {
      title: 'Add contact',
      close: 'Close',
      tabAdd: '🔗 By token',
      tabMine: '📤 My token',
      info: 'Paste the token your contact shared with you. On the first message we check that it really is them.',
      fieldToken: "Contact's token",
      phToken: 'e.g. A4F2',
      paste: 'Paste',
      fieldAlias: 'Nickname (optional)',
      phAlias: 'e.g. Bob from chess',
      hint: 'We will send them an encrypted hello signed with your identity. Once they reply, they show up in your list automatically.',
      mineInfo: 'Share this token with your contact. It changes every time you connect, but your identity stays the same.',
      copy: 'Copy',
      cancel: 'Cancel',
      send: 'Send hello',
      done: 'Done',
      errInvalid: 'Invalid token (4-8 letters or numbers, uppercase).',
      errOwn: 'That is your own token.',
      errSend: 'The hello could not be sent.',
    },

    list: {
      emptyBefore: "You don't have any contacts yet.",
      emptyPress: 'Press',
      emptyAfter: 'to add one.',
      rate: 'Rate',
      noMessages: 'No messages',
      ratingMine: 'Your rating',
      ratingDerived: 'Rating estimated from your trust network',
    },

    conv: {
      back: 'Back',
      rate: 'Rate',
      online: 'online',
      offline: 'offline · messages will wait',
      emptyBig: 'No messages yet',
      emptySmall: 'Say hi and start the conversation 👋',
      today: 'Today',
      yesterday: 'Yesterday',
      attach: 'Attach (coming soon)',
      placeholder: 'Write a message…',
      send: 'Send',
    },

    requests: {
      title: 'Contact requests',
      empty: 'No pending requests.',
      vouched: 'vouched by your network',
      vouchedTitle: 'Vouched by your trust network',
      stranger: 'stranger',
      strangerTitle: 'Stranger: nobody in your network vouches for them',
      defaultMsg: 'Wants to add you as a contact',
      accept: 'Accept and add to contacts',
      dismiss: 'Dismiss',
    },

    incoming: { newMessage: 'New message' },

    fallbackNick: 'Me',
  },
}
