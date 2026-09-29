package com.dotrino.messenger

import android.view.Gravity
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.dotrino.messenger.engine.MessengerEngine

/**
 * Rate a contact: trust and affinity, 0–5. Trust is the anchor of the web of trust (it also
 * goes to my address book); both go to the registry signed. What I rated before comes back.
 */
class RateSheet(private val a: MainActivity, private val e: MessengerEngine, private val pk: String) {
    private val values = mutableMapOf("confianza" to 0, "afinidad" to 0)

    fun show() {
        a.launch {
            val name = e.contacts().firstOrNull { str(it, "publickey") == pk }?.let { str(it, "nickname") }?.ifEmpty { null } ?: pk.take(8)
            val (dialog, body) = a.sheet(t("native.rateTitle", "name" to name))
            val rows = mutableMapOf<String, LinearLayout>()
            fun paint() = rows.forEach { (axis, row) ->
                for (i in 0 until row.childCount) (row.getChildAt(i) as TextView).setTextColor(a.col(if (i < (values[axis] ?: 0)) R.color.m_gold else R.color.m_line2))
            }
            for ((axis, key) in listOf("confianza" to "native.rateTrust", "afinidad" to "native.rateAffinity")) {
                body.add(a.label(t(key), 14f, a.col(R.color.m_muted), bold = true), top = 12)
                val row = LinearLayout(a).apply {
                    gravity = Gravity.CENTER_VERTICAL; tag = "stars-$axis"
                    for (n in 1..5) addView(a.label("★", 34f).apply {
                        setPadding(a.px(4), 0, a.px(4), 0); contentDescription = "$n"
                        setOnClickListener { values[axis] = if (values[axis] == n) 0 else n; paint() }
                    })
                }
                rows[axis] = row
                body.add(row, top = 4)
            }
            body.add(a.pill(t("native.rateSave"), filled = true) {
                a.launch {
                    runCatching { e.rate(pk, values.toMap()) }
                        .onSuccess { a.toast(t("native.rateSaved")); dialog.dismiss() }
                        .onFailure { a.toast(t("native.rateFailed", "reason" to (it.message ?: ""))) }
                }
            }.apply { tag = "rate-save" }, top = 20)
            paint()
            dialog.show()
            // What I rated before, from the registry (merged per axis).
            runCatching { e.myIndicatorsFor(pk) }.getOrNull()?.forEach { (k, v) -> if (k in values) values[k] = v.toInt() }
            paint()
            e.askRatingsAbout(pk)
        }
    }
}
