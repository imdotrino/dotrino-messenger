package com.dotrino.messenger

import android.app.Dialog
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.dotrino.messenger.engine.MessengerEngine
import com.dotrino.sdk.BleWire
import com.dotrino.sdk.Delegation
import com.dotrino.sdk.ui.DotrinoQr
import kotlinx.coroutines.Job

/**
 * «Add contact»: the two tabs of the PWA and one of the phone. BY CODE: the other person's 6
 * characters (typed, pasted or scanned) and an optional alias → a contact REQUEST. MY CODE: mine,
 * and its QR (a link, so a phone's camera opens the messenger with the code in place). NEARBY
 * (only native: a browser cannot announce): while it is open, my contact card goes out over
 * Bluetooth and the cards of whoever is near come in (`dotrino-vault/docs/pairing-protocol.md`
 * §1.8); «Add» sends the same request as a link. Several at once is normal: no incident here.
 */
class AddSheet(private val a: MainActivity, private val e: MessengerEngine, code: String?, private val scan: () -> Unit, startTab: String = "add",
               /** From a `#to=` link (the feedback email): whom to ask, with no code. */
               private val peer: MainActivity.LinkPeer? = null) {
    val dialog: Dialog
    private val body: LinearLayout
    private var tab = startTab
    private val input = a.field(t("add.phToken")).apply { tag = "code-input"; setText(code ?: ""); typeface = android.graphics.Typeface.MONOSPACE; gravity = Gravity.CENTER }
    private val alias = a.field(t("add.phAlias")).apply { tag = "alias-input"; peer?.nickname?.let { setText(it) } }
    private val error = a.label("", 14f, a.col(R.color.m_danger)).apply { visibility = View.GONE; tag = "add-error" }
    private var sending = false

    init {
        val (d, b) = a.sheet(t("add.title"))
        dialog = d; body = b
        render()
    }

    /** The sheet closed: nothing stays announced. */
    fun closed() = stopNearby()

    // ---- nearby ----

    private class Found(val card: BleWire.Contact, var state: String = "new")
    private val found = LinkedHashMap<String, Found>()
    private var nearbyError: String? = null
    private var nearbyOn = false
    private var unannounce: (() -> Unit)? = null
    private var looking: Job? = null

    /** On: announce my card and look, in rounds, until the tab or the sheet closes. */
    private fun startNearby() {
        if (nearbyOn) return
        nearbyOn = true
        nearbyError = null
        a.withBluetooth { why ->
            if (!nearbyOn) return@withBluetooth
            if (why != null) { nearbyError = why; nearbyOn = false; if (tab == "nearby") render(); return@withBluetooth }
            val bt = Messenger.bluetooth ?: return@withBluetooth
            val me = Messenger.profile?.publickey ?: return@withBluetooth
            try { unannounce = bt.announce(BleWire.KIND_CONTACT, BleWire.encodeContact(me, e.nickname)) }
            catch (x: Exception) { android.util.Log.w("messenger", "nearby: announce", x); nearbyError = "nearbyUnavailable"; nearbyOn = false; render(); return@withBluetooth }
            looking = a.launch {
                val mine = e.contacts().mapNotNull { it["publickey"]?.let { k -> (k as? kotlinx.serialization.json.JsonPrimitive)?.content } }
                while (nearbyOn) {
                    try {
                        bt.discover(BleWire.KIND_CONTACT, 6000) { data ->
                            val c = BleWire.decodeContact(data) ?: return@discover
                            if (Delegation.samePubkey(c.publickey, me)) return@discover
                            a.runOnUiThread {
                                if (found.keys.none { Delegation.samePubkey(it, c.publickey) }) {
                                    found[c.publickey] = Found(c, if (mine.any { Delegation.samePubkey(it, c.publickey) }) "contact" else "new")
                                    if (tab == "nearby" && dialog.isShowing) render()
                                }
                            }
                        }
                    } catch (x: Exception) { android.util.Log.w("messenger", "nearby: discover", x); kotlinx.coroutines.delay(1000) }
                }
            }
            if (tab == "nearby") render()
        }
    }

    private fun stopNearby() {
        nearbyOn = false
        unannounce?.invoke(); unannounce = null
        looking?.cancel(); looking = null
    }

    private fun nearbyTab() {
        body.add(a.label(t("native.nearbyInfo"), 14f, a.col(R.color.m_muted)), top = 16)
        nearbyError?.let { body.add(a.label(t("native.$it"), 14f, a.col(R.color.m_danger)).apply { tag = "nearby-error" }, top = 12); return }
        if (found.isEmpty()) {
            body.add(a.label(t(if (nearbyOn) "native.nearbySearching" else "native.nearbyNone"), 14f).apply { tag = "nearby-searching" }, top = 16)
            if (nearbyOn) body.add(a.label(t("native.nearbyNone"), 13f, a.col(R.color.m_muted)), top = 6)
            return
        }
        for (f in found.values) body.add(LinearLayout(a).apply {
            gravity = Gravity.CENTER_VERTICAL; tag = "nearby-item"
            val name = f.card.nickname.ifEmpty { t("native.nearbyNoNick") }
            addView(a.avatar(name, f.card.publickey, 40))
            addView(a.label(name, 16f, bold = true).apply { setPadding(a.px(12), 0, a.px(8), 0) }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            when (f.state) {
                "contact" -> addView(a.label(t("native.nearbyContact"), 13f, a.col(R.color.m_muted)))
                "sent" -> addView(a.label(t("native.nearbySent"), 13f, a.col(R.color.m_muted)))
                "sending" -> addView(a.label(t("add.sending"), 13f, a.col(R.color.m_muted)))
                else -> addView(a.pill(t("native.nearbyAdd"), filled = true) { addNearby(f) }.apply { tag = "nearby-add" })
            }
        }, top = 12)
        detach(error); body.add(error, top = 10)
    }

    private fun addNearby(f: Found) {
        error.visibility = View.GONE
        f.state = "sending"; render()
        a.launch {
            try {
                e.addByLink(f.card.publickey, f.card.nickname, null)
                f.state = "sent"
            } catch (x: MessengerEngine.EngineError) {
                f.state = "new"; showError(if (x.code == "offline") "errOffline" else "errSend")
            } catch (x: Exception) { android.util.Log.w("messenger", "request nearby", x); f.state = "new"; showError("errSend") }
            if (dialog.isShowing && tab == "nearby") render()
        }
    }

    fun refresh() { if (tab == "mine") render() }

    /** What the scanner (or a photo) read: a code, or nothing usable. */
    fun scanned(code: String?) {
        tab = "add"
        if (code == null) { render(); showError("errNoCode"); return }
        input.setText(code); render(); submit()
    }

    private fun showError(key: String) { error.text = t("add.$key"); error.visibility = View.VISIBLE }

    private fun render() {
        body.removeAllViews()
        body.add(LinearLayout(a).apply {
            background = rounded(a.col(R.color.m_card2), a.px(24)); setPadding(a.px(4), a.px(4), a.px(4), a.px(4))
            for ((id, key) in listOf("add" to "add.tabAdd", "mine" to "add.tabMine", "nearby" to "native.nearbyTab")) addView(a.label(t(key), 14f, a.col(if (tab == id) R.color.m_text else R.color.m_muted), bold = tab == id).apply {
                gravity = Gravity.CENTER; setPadding(0, a.px(9), 0, a.px(9)); tag = when (id) { "mine" -> "share-my-token-tab"; "nearby" -> "nearby-tab"; else -> "add-tab" }
                if (tab == id) background = rounded(a.col(R.color.m_card), a.px(20))
                setOnClickListener { if (id == "nearby" && tab != id) nearbyError = null; tab = id; render() }
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        })
        if (tab != "nearby") stopNearby() else if (nearbyError == null) startNearby()
        if (tab == "add" && peer != null) toTab() else if (tab == "add") addTab() else if (tab == "nearby") nearbyTab() else mineTab()
    }

    private fun detach(v: View) { (v.parent as? ViewGroup)?.removeView(v) }

    private fun addTab() {
        body.add(a.label(t("add.info"), 14f, a.col(R.color.m_muted)), top = 16)
        body.add(a.label(t("add.fieldToken"), 13f, a.col(R.color.m_muted), bold = true), top = 14)
        detach(input)
        body.add(LinearLayout(a).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(a.pill(t("add.paste")) {
                val clip = (a.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
                clip?.getItemAt(0)?.coerceToText(a)?.toString()?.let { input.setText(MainActivity.codeFrom(it)) }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { leftMargin = a.px(8) })
        }, top = 6)
        body.add(a.pill(t("add.scan")) { scan() }.apply { tag = "scan-qr" }, top = 10, width = ViewGroup.LayoutParams.WRAP_CONTENT)
        body.add(a.label(t("add.fieldAlias"), 13f, a.col(R.color.m_muted), bold = true), top = 14)
        detach(alias); body.add(alias, top = 6)
        detach(error); body.add(error, top = 10)
        body.add(a.label(t("add.hint"), 13f, a.col(R.color.m_muted)), top = 10)
        body.add(a.pill(if (sending) t("add.sending") else t("add.send"), filled = true) { submit() }.apply { tag = "send-hello"; isEnabled = !sending; alpha = if (sending) 0.5f else 1f }, top = 16)
    }

    /** A request to the key of a link: who it goes to, the alias, and «send». */
    private fun toTab() {
        val nick = peer!!.nickname.ifEmpty { t("add.toNoNick") }
        body.add(a.label(t("add.toInfo").replace("{nick}", nick), 14f, a.col(R.color.m_muted)).apply { tag = "to-info" }, top = 16)
        body.add(a.label(t("add.fieldAlias"), 13f, a.col(R.color.m_muted), bold = true), top = 14)
        detach(alias); body.add(alias, top = 6)
        detach(error); body.add(error, top = 10)
        body.add(a.label(t("add.hint"), 13f, a.col(R.color.m_muted)), top = 10)
        body.add(a.pill(if (sending) t("add.sending") else t("add.send"), filled = true) { submitToPeer() }.apply { tag = "send-hello"; isEnabled = !sending; alpha = if (sending) 0.5f else 1f }, top = 16)
    }

    private fun submitToPeer() {
        val p = peer ?: return
        if (sending) return
        error.visibility = View.GONE
        sending = true; render()
        a.launch {
            try {
                e.addByLink(p.pubkey, alias.text.toString(), p.card)
                dialog.dismiss()
            } catch (x: MessengerEngine.EngineError) {
                showError(if (x.code == "offline") "errOffline" else "errSend")
            } catch (x: Exception) { android.util.Log.w("messenger", "request by link", x); showError("errSend") }
            sending = false
            if (dialog.isShowing) render()
        }
    }

    private fun mineTab() {
        val code = e.pairingCode
        body.add(a.label(t("add.mineInfo"), 14f, a.col(R.color.m_muted)), top = 16)
        body.add(LinearLayout(a).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(a.label(code ?: "…", 28f, bold = true).apply { typeface = android.graphics.Typeface.MONOSPACE; letterSpacing = 0.15f; tag = "my-pairing-code" },
                LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(a.pill(t("add.copy")) {
                code ?: return@pill
                (a.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(android.content.ClipData.newPlainText("code", code))
            })
        }, top = 12)
        if (code != null) {
            val size = a.px(220)
            body.add(LinearLayout(a).apply {
                gravity = Gravity.CENTER
                addView(ImageView(a).apply {
                    tag = "my-qr"
                    setImageBitmap(DotrinoQr.bitmap("https://messenger.dotrino.com/#add=$code", size, Color.BLACK, Color.WHITE))
                    background = rounded(Color.WHITE, a.px(16)); setPadding(a.px(10), a.px(10), a.px(10), a.px(10))
                }, LinearLayout.LayoutParams(size + a.px(20), size + a.px(20)))
            }, top = 16)
            body.add(a.label(t("add.qrHint"), 13f, a.col(R.color.m_muted)).apply { gravity = Gravity.CENTER }, top = 8)
        }
    }

    private fun submit() {
        if (sending) return
        error.visibility = View.GONE
        val code = MainActivity.normalize(input.text.toString())
        if (!Regex("^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$").matches(code)) { showError("errInvalid"); return }
        sending = true; render()
        a.launch {
            try {
                e.addByCode(code, alias.text.toString())
                dialog.dismiss()
            } catch (x: MessengerEngine.EngineError) {
                // «Offline» and «that code is not valid» are fixed differently: say which.
                showError(when (x.code) { "own" -> "errOwn"; "offline" -> "errOffline"; "invalid" -> "errInvalid"; else -> "errSend" })
            } catch (x: Exception) { android.util.Log.w("messenger", "add contact", x); showError("errSend") }
            sending = false
            if (dialog.isShowing) render()
        }
    }
}
