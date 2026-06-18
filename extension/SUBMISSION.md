# Submission checklist (Chrome Web Store)

Step-by-step from "code on disk" to "approved & public listing".

## 1. Pre-flight

- [ ] All `console.log`/debug statements removed or guarded (none in v1).
- [ ] `manifest.json` version bumped to `1.0.0` for first public submission (current `0.1.0` is fine for unlisted/dev).
- [ ] Icons present at the sizes the toolbar uses (16/32/48/128 — Chrome will accept the 192 we point at, but a true 128×128 looks crisper).
- [ ] PRIVACY.md and PERMISSIONS.md committed to `main` and reachable on github.com.
- [ ] `chrome://extensions/` → "Pack extension" produces a valid `.zip` from this folder, OR run:
      ```bash
      cd dotrino-messenger_extension
      zip -r ../cc-messenger-extension.zip . -x "*.git*" -x "node_modules/*" -x "*.zip"
      ```

## 2. Create / configure the developer account

1. Sign in at https://chrome.google.com/webstore/devconsole/.
2. Pay the **one-time USD 5** registration fee (you can only submit after this).
3. Verify your contact email.

## 3. Submit a new item

1. **"Add new item"** → upload the `.zip` from step 1.
2. **"Store listing"** tab — fill from `STORE_LISTING.md`:
   - Name, summary, description.
   - Category: Communication.
   - Language: English.
   - Upload screenshots + promo tile (see asset checklist in `STORE_LISTING.md`).
3. **"Privacy practices"** tab:
   - Single purpose: paste the statement from `STORE_LISTING.md`.
   - For each of `storage`, `offscreen`, `notifications`, `alarms`, `host_permissions`, plus `<all_urls>`: paste the matching paragraph from `PERMISSIONS.md`.
   - "Are you using remote code?" → **No**.
   - "Are you collecting personal/sensitive data?" → **No** (the only PII is the encryption keypair, which never leaves the user's device).
   - Privacy policy URL: `https://github.com/imdotrino/dotrino-messenger_extension/blob/main/PRIVACY.md`.
4. **"Distribution"** tab:
   - Visibility: **Public** (or Unlisted if you want to soft-launch).
   - Geographies: all.
5. Click **"Submit for review"**.

## 4. Review timeline

- First review usually 3–7 days.
- If rejected, you'll get an email with the specific clause(s) that failed. Common causes (and answers):
  - "Permission too broad" → reviewers want a narrower justification. Re-paste the relevant section from `PERMISSIONS.md` verbatim.
  - "Single purpose unclear" → re-paste the single-purpose statement.
  - "Privacy policy missing" → confirm the URL is publicly reachable (try it incognito).
- Re-submit the same `.zip` with `manifest.json` version unchanged is fine; if you change anything, bump `version` first.

## 5. Post-approval

- The extension goes live at `https://chromewebstore.google.com/detail/<id>` within ~30 minutes of approval.
- Update the README + the landing page (`dotrino/src/App.vue`) to point to that URL instead of the GitHub repo install instructions.
- Subsequent updates: bump `version`, re-zip, re-upload — review on updates is normally faster (~24 h) unless the diff touches permissions.

## Useful URLs

- Developer console: https://chrome.google.com/webstore/devconsole/
- MV3 review docs: https://developer.chrome.com/docs/webstore/program-policies/
- Privacy policy requirements: https://developer.chrome.com/docs/webstore/program-policies/privacy/
