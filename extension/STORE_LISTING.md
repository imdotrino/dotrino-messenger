# Chrome Web Store listing copy

Paste these strings into the Web Store developer dashboard during submission.

---

## Name (≤ 45 chars)

```
Dotrino Messenger
```

## Short description / summary (≤ 132 chars)

```
End-to-end encrypted P2P messages, overlaid on any page. Shared identity with the Dotrino ecosystem.
```

## Category

`Communication` (primary).

## Language

`English` as primary; the in-product UI is bilingual (Spanish + English fragments) — declare English to keep review simple.

## Detailed description (≤ 16,000 chars — keep it tight)

```
Dotrino Messenger is the Chrome extension companion to the Dotrino ecosystem (https://dotrino.com/). It lets you receive and reply to encrypted peer-to-peer messages on any page you visit, without switching tabs.

What you get
• Toast notification when a message arrives, plus a slide-in panel to read the full thread.
• Floating button to open the panel on demand at any time.
• A toolbar popup that mirrors the panel UI for when you'd rather not overlay.
• Native Chrome notifications when the panel is closed, so you don't miss anything.

How privacy works
• Messages are end-to-end encrypted with ECDH P-256 key agreement and AES-256-GCM. The relay server cannot decrypt them.
• The encryption keypair lives in the shared identity vault at id.dotrino.com — the same vault used by every Dotrino app, so your contacts and reputation follow you across the ecosystem.
• If the recipient is offline, the relay holds the ciphertext in memory for up to 24 hours and delivers it the moment they reconnect. After 24 hours it is dropped.
• No analytics, no telemetry, no advertising, no third-party SDKs, no remote code. Full source at github.com/imdotrino/dotrino-messenger_extension.

Required setup
1. Visit https://messenger.dotrino.com/ once and pick a nickname. This initialises the shared vault.
2. Install the extension. It will discover your identity automatically and connect to the relay.
3. Add contacts from the web app (paste their token). The extension reuses the same contact list.

Limitations
• The overlay does not appear on Chrome's internal pages (chrome://, the Web Store) or sites with a strict CSP that blocks injected stylesheets — that's enforced by the browser, not by us.

Open source
Everything is MIT-licensed: the extension, the identity vault, the WebSocket proxy, and the sister web apps (chat, chess, messenger, qrshare). Audit, fork, self-host.
```

## Justification answers (for the form)

Copy from `PERMISSIONS.md`. Each permission has its own field on the form.

## Privacy policy URL

Either:

- `https://github.com/imdotrino/dotrino-messenger_extension/blob/main/PRIVACY.md` (works for review)
- or, if you prefer a hosted page, enable GitHub Pages on this repo and use `https://dotrino.github.io/dotrino-messenger_extension/PRIVACY.html` (would require a build step or a Jekyll config — the GitHub blob URL is simpler).

## Single purpose statement

```
Display incoming end-to-end-encrypted messages from the Dotrino P2P network as an overlay on any page the user is currently visiting, and let the user reply without leaving that page.
```

## Visibility

Choose **Public** for full Web Store discoverability, or **Unlisted** for link-only sharing while you onboard early users.

## Distribution country

All countries (default).

## Asset checklist (you upload these manually during submission)

| Asset | Size | Status |
|---|---|---|
| Icon (Web Store listing) | 128×128 PNG, no padding | TODO — generate from `icons/icon-192.png` |
| Small promo tile | 440×280 PNG | TODO |
| Marquee promo tile (optional) | 1400×560 PNG | optional |
| Screenshots | 1280×800 or 640×400 PNG, ≥1 (≤5) | TODO — capture overlay in action + popup |

The fastest way to take screenshots: load the unpacked extension, open `https://example.com`, trigger a DM (use the Node test from `simple-websocket-proxy/test-offline.mjs` adapted to send a real envelope, or simply send yourself a message from the web messenger). Capture the toast and the open panel.

## Account / billing

- Pay the **one-time USD 5 developer registration fee** at https://chrome.google.com/webstore/devconsole/.
- Verify your email + (optionally) link a Google Group for support.
