# Permission justifications

Use these answers verbatim when the Chrome Web Store form asks "why is this permission needed?". They are tuned for the criteria reviewers use ("narrow", "least privilege", "necessary for the single purpose").

## Single purpose

Display incoming end-to-end-encrypted messages from the Dotrino P2P network as an overlay on any page the user is currently visiting, and let the user reply without leaving that page. Identity, contacts, and message history are loaded from the cross-origin Dotrino ecosystem (`messenger.dotrino.com`, `id.dotrino.com`, `store.dotrino.com`); the extension itself does not store user data.

## Permission justifications

### `offscreen`
Required to host the messenger PWA (`https://messenger.dotrino.com/`) inside an iframe in an offscreen document. That iframe maintains the WebSocket connection to the proxy server, performs the cryptographic handshakes and decryption, and persists threads to the shared `store.dotrino.com` origin. Without an offscreen document the extension cannot receive messages while no browser tab is visible.

### `notifications`
Used to fire a single native notification when an encrypted DM arrives **and** the in-page overlay panel is closed. Without this permission, users would miss messages that arrive on tabs they aren't actively looking at. No marketing or non-message notifications are ever fired.

### `alarms`
Manifest V3 service workers are terminated after ~30 seconds of inactivity. A 1-minute alarm wakes the worker so it can re-create the offscreen document if Chrome recycled it, ensuring the messenger PWA inside keeps its connection alive.

### Host permission `https://messenger.dotrino.com/*`
The full app UI lives at this origin. The extension loads it as an iframe in three places: the offscreen document (background presence), the toolbar popup, and an in-page slide-in panel. All cryptographic operations and storage calls happen inside that origin's sandbox, not in the extension itself.

### Host permission `https://id.dotrino.com/*`
The cross-app identity vault. The messenger PWA loads this as a sub-iframe to access the user's keypair and shared contact book. The extension only declares this host because the iframe needs to navigate there.

### Host permission `https://store.dotrino.com/*`
The cross-instance message thread store. Same rationale as `id.dotrino.com`: the messenger PWA loads it as a sub-iframe to read/write threads that the user can also see in the web app.

### Host permission `wss://proxy.dotrino.com/*`
The actual transport. The messenger PWA inside the offscreen iframe opens a WebSocket to this URL to send and receive encrypted messages.

### `<all_urls>` content script match
The extension's value proposition is *"see and reply to messages without leaving the page you're on"*. The injected UI is a Shadow-DOM root that does not read or modify the host page in any way — it only renders the overlay/toast. Excluded explicitly: `chromewebstore.google.com`, `chrome.google.com/webstore/*` (where injection is forbidden by Chrome itself), and `messenger.dotrino.com/*` (the PWA itself, where injecting our own iframe would be circular).

## Remote code

None. All JavaScript inside the extension package is reviewable in the [public source repository](https://github.com/imdotrino/dotrino-messenger). The extension does not use `eval`, dynamic `import()` from remote URLs, or `chrome.scripting.executeScript` with user-supplied code. The cross-origin iframes (`messenger.dotrino.com`, `id.dotrino.com`, `store.dotrino.com`) load their own static JS from the same author's separate open-source repos; the extension only exchanges structured `postMessage` requests with them, never executing their code in the extension's context.

## Data handling

The extension itself does not store any user data. All persistence happens in the localStorage of the cross-origin domains (`id.dotrino.com` for keypairs and contacts, `store.dotrino.com` for message threads). No analytics, no telemetry, no third-party SDKs.
