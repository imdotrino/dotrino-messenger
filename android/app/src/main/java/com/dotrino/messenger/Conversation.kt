package com.dotrino.messenger

import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.LinearLayout
import android.widget.ScrollView
import com.dotrino.messenger.engine.MessengerEngine
import kotlinx.serialization.json.JsonPrimitive

/** One conversation: header (back, name, online, rate), the messages, and the composer. */
class Conversation(
    private val a: MainActivity,
    private val e: MessengerEngine,
    private val pk: String,
    private val onBack: () -> Unit,
    private val onRate: (String) -> Unit,
) {
    suspend fun build(): View {
        val contact = e.contacts().firstOrNull { str(it, "publickey") == pk }
        val name = str(contact, "nickname").ifEmpty { pk.take(8) }
        val online = e.isOnline(pk)
        val root = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL }

        root.addView(LinearLayout(a).apply {
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(a.col(R.color.m_card)); setPadding(a.px(8), a.px(10), a.px(12), a.px(10))
            addView(a.label("←", 22f).apply { setPadding(a.px(10), a.px(4), a.px(12), a.px(4)); contentDescription = t("conv.back"); tag = "conv-back"; setOnClickListener { onBack() } })
            addView(a.avatar(name, pk, 38))
            addView(LinearLayout(a).apply {
                orientation = LinearLayout.VERTICAL; setPadding(a.px(10), 0, 0, 0)
                add(a.label(name, 16f, bold = true).apply { isSingleLine = true })
                add(a.label(if (online) t("conv.online") else t("conv.offline"), 12f, a.col(if (online) R.color.m_online else R.color.m_muted)).apply { isSingleLine = true })
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(a.label("★", 22f, a.col(R.color.m_gold)).apply { setPadding(a.px(10), a.px(4), a.px(6), a.px(4)); contentDescription = t("conv.rate"); tag = "rate"; setOnClickListener { onRate(pk) } })
        })

        // Version notice (§14): shown, never blocking.
        e.peerCompat[pk]?.let { mark ->
            root.addView(a.label(t("conv.compat.$mark"), 13f, a.col(R.color.m_text)).apply {
                setBackgroundColor(a.col(R.color.m_card2)); setPadding(a.px(16), a.px(8), a.px(16), a.px(8))
            })
        }

        val list = LinearLayout(a).apply { orientation = LinearLayout.VERTICAL; setPadding(a.px(12), a.px(12), a.px(12), a.px(12)) }
        val thread = e.thread(pk)
        if (thread.isEmpty()) {
            list.add(a.label(t("conv.emptyBig"), 18f, bold = true).apply { gravity = Gravity.CENTER }, top = 40)
            list.add(a.label(t("conv.emptySmall"), 15f, a.col(R.color.m_muted)).apply { gravity = Gravity.CENTER }, top = 6)
        }
        for (m in thread) list.add(bubble(m.toMap().mapValues { it.value }), top = 6)
        val scroll = ScrollView(a).apply { addView(list); isFillViewport = true }
        root.addView(scroll, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }

        val input = a.field(t("conv.placeholder"), single = false).apply {
            tag = "composer-input"; maxLines = 5; imeOptions = EditorInfo.IME_ACTION_SEND
            background = rounded(a.col(R.color.m_card), a.px(24), a.px(1), a.col(R.color.m_line2))
        }
        val send = a.label("➤", 18f, a.col(R.color.m_on_accent)).apply {
            gravity = Gravity.CENTER; tag = "send-message"; contentDescription = t("conv.send")
            background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(a.col(R.color.m_accent)) }
            setOnClickListener {
                val text = input.text.toString()
                if (text.isBlank()) return@setOnClickListener
                input.setText("")
                a.launch { runCatching { e.sendDM(pk, text) }.onFailure { a.toast(t("native.sealFailed", "reason" to (it.message ?: ""))) } }
            }
        }
        root.addView(LinearLayout(a).apply {
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(a.col(R.color.m_card)); setPadding(a.px(12), a.px(8), a.px(12), a.px(8))
            addView(input, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(send, LinearLayout.LayoutParams(a.px(46), a.px(46)).apply { leftMargin = a.px(8) })
        })
        return root
    }

    private fun bubble(m: Map<String, kotlinx.serialization.json.JsonElement>): View {
        val mine = (m["dir"] as? JsonPrimitive)?.content == "out"
        val text = (m["text"] as? JsonPrimitive)?.content ?: ""
        val ts = (m["ts"] as? JsonPrimitive)?.content?.toLongOrNull() ?: 0
        val pending = (m["pending"] as? JsonPrimitive)?.content == "true"
        return LinearLayout(a).apply {
            gravity = if (mine) Gravity.END else Gravity.START
            addView(LinearLayout(a).apply {
                orientation = LinearLayout.VERTICAL
                tag = if (mine) "msg-out" else "msg-in"
                background = rounded(a.col(if (mine) R.color.m_accent else R.color.m_card), a.px(18), if (mine) 0 else a.px(1), a.col(R.color.m_line))
                setPadding(a.px(14), a.px(9), a.px(14), a.px(7))
                // Text as TEXT, never markup: what the other side wrote arrives letter by letter.
                add(a.label(text, 15.5f, a.col(if (mine) R.color.m_on_accent else R.color.m_text)).apply { setTextIsSelectable(true) })
                add(a.label(a.clock(ts) + if (mine) (if (pending) "  ⏱" else "  ✓") else "", 11f, if (mine) 0xCCFFFFFF.toInt() else a.col(R.color.m_muted)).apply { gravity = Gravity.END }, top = 2)
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                if (mine) leftMargin = a.px(48) else rightMargin = a.px(48)
            })
        }
    }
}
