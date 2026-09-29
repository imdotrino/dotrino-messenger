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
import com.dotrino.sdk.ui.DotrinoQr

/**
 * «Add contact»: two tabs, like the PWA. BY CODE: the other person's 6 characters (typed,
 * pasted or scanned) and an optional alias → a contact REQUEST. MY CODE: mine, and its QR (a
 * link, so a phone's camera opens the messenger with the code in place).
 */
class AddSheet(private val a: MainActivity, private val e: MessengerEngine, code: String?, private val scan: () -> Unit, startTab: String = "add") {
    val dialog: Dialog
    private val body: LinearLayout
    private var tab = startTab
    private val input = a.field(t("add.phToken")).apply { tag = "code-input"; setText(code ?: ""); typeface = android.graphics.Typeface.MONOSPACE; gravity = Gravity.CENTER }
    private val alias = a.field(t("add.phAlias")).apply { tag = "alias-input" }
    private val error = a.label("", 14f, a.col(R.color.m_danger)).apply { visibility = View.GONE; tag = "add-error" }
    private var sending = false

    init {
        val (d, b) = a.sheet(t("add.title"))
        dialog = d; body = b
        render()
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
            for ((id, key) in listOf("add" to "add.tabAdd", "mine" to "add.tabMine")) addView(a.label(t(key), 14f, a.col(if (tab == id) R.color.m_text else R.color.m_muted), bold = tab == id).apply {
                gravity = Gravity.CENTER; setPadding(0, a.px(9), 0, a.px(9)); tag = if (id == "mine") "share-my-token-tab" else "add-tab"
                if (tab == id) background = rounded(a.col(R.color.m_card), a.px(20))
                setOnClickListener { tab = id; render() }
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        })
        if (tab == "add") addTab() else mineTab()
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
