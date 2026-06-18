# Privacy Policy — Dotrino Messenger (Chrome Extension)

_Last updated: 2026-05-04_

This extension is part of the open-source [Dotrino](https://github.com/imdotrino) ecosystem. It provides end-to-end-encrypted peer-to-peer messaging on top of a thin WebSocket relay.

## What data the extension handles

| Data | Where it lives | Who can read it |
|---|---|---|
| Your identity keypairs (ECDSA P-256 for signing, ECDH P-256 for encryption) | `localStorage` of `https://id.dotrino.com/` (the shared identity vault, loaded inside an offscreen iframe) | Only you, on your device |
| Your contact list (peer pubkeys, nicknames, ratings) | Same vault as above | Only you, on your device |
| Recent message history (up to 80 messages per contact) | `chrome.storage.local` of this extension | Only you, on your device |
| Your messages in transit | Encrypted with AES-256-GCM and a per-message ECDH-derived key, then sent through `wss://proxy.dotrino.com` | Only the recipient (the proxy operator cannot decrypt) |

## What the extension does NOT do

- **No analytics.** No telemetry, no usage tracking, no third-party SDKs.
- **No advertising.**
- **No remote code.** All JavaScript is bundled with the extension and reviewable in the [public repository](https://github.com/imdotrino/dotrino-messenger_extension). No `eval`, no remotely loaded scripts.
- **No reading the contents of pages you visit.** The overlay is injected as a Shadow-DOM root and does not access the host page's DOM, cookies, or storage.
- **No selling, sharing, or transferring** of any data to third parties.

## What the proxy server sees

The relay at `wss://proxy.dotrino.com` (open source, [dotrino/simple-websocket-proxy](https://github.com/imdotrino/simple-websocket-proxy)) sees:

- The **ciphertext** of your messages (it cannot decrypt them).
- The **public keys** of senders and recipients (this is required to route).
- IP addresses (for rate limiting only — not retained beyond the IP-ban window of 30 minutes after abuse).

Offline messages are **kept in memory** for at most 24 hours, then permanently dropped if the recipient never reconnects.

## Permissions used

See [PERMISSIONS.md](./PERMISSIONS.md) for a per-permission justification.

## Data deletion

You can clear all extension data at any time:

1. Right-click the extension icon → **"Manage extension"** → **"Site settings"** → clear storage.
2. To also clear the shared identity vault: open `https://id.dotrino.com/`, run `localStorage.clear()` in the console.
3. Removing the extension also removes its `chrome.storage.local` cache.

## Contact

Open an issue at [github.com/imdotrino/dotrino-messenger_extension/issues](https://github.com/imdotrino/dotrino-messenger_extension/issues).
