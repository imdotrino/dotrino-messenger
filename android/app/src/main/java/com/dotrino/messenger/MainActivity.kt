package com.dotrino.messenger

import android.Manifest
import android.app.Activity
import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.dotrino.messenger.engine.MessengerEngine
import com.dotrino.sdk.ui.DotrinoQr
import com.dotrino.sdk.ui.DotrinoTopbar
import com.dotrino.sdk.ui.DotrinoLocale
import com.dotrino.sdk.ui.IdentityRequired
import com.dotrino.sdk.ui.QrScanView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * The app: the contacts (with the requests on top) and, from there, a conversation. «Back» from
 * a conversation returns to the list; from the list, leaves. Plain native views.
 */
class MainActivity : Activity() {
    companion object {
        private const val REQ_CAMERA = 11
        private const val REQ_NOTIF = 12
        private const val REQ_PHOTO = 13
        private const val CODE_RE = "^[1-9ACDEFHJKMNOPQRTUVWXY]{6}$"
        /** The same translation as the proxy: only what it never emits is mapped. */
        private val CONFUSABLES = mapOf('I' to '1', 'L' to '1', 'S' to '5', 'Z' to '2', 'B' to '8', 'G' to '6', '0' to 'O')
        fun normalize(raw: String) = raw.uppercase().filter { it != ' ' && it != '-' && it != '_' }.map { CONFUSABLES[it] ?: it }.joinToString("")
        fun codeFrom(text: String): String = normalize(Regex("[#&?]add=([^&\\s]+)", RegexOption.IGNORE_CASE).find(text)?.groupValues?.get(1) ?: text).take(6)
    }

    private val ui = Handler(Looper.getMainLooper())
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var engine: MessengerEngine? = null
    private var open: String? = null                 // the contact whose conversation is on screen
    private var content: FrameLayout? = null
    private var status: TextView? = null
    private var rerenderQueued = false
    private var resumed = false
    private var addSheet: Pair<Dialog, AddSheet>? = null
    private var scanDialog: Dialog? = null
    private var pendingCode: String? = null
    private lateinit var notify: Notify

    override fun attachBaseContext(base: Context) = super.attachBaseContext(DotrinoLocale.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        I18n.load(this)
        notify = Notify(this)
        open = savedInstanceState?.getString("open")
        pendingCode = codeIn(intent)
        setContentView(shell())
        boot()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // The app already open also receives the QR link (launchMode singleTask).
        codeIn(intent)?.let { pendingCode = it; if (engine?.hasNickname == true) openAdd(it) }
        intent.getStringExtra(Notify.EXTRA_CONTACT)?.let { openConversation(it) }
    }

    private fun codeIn(i: Intent?): String? = i?.data?.fragment?.let { f -> Regex("add=([^&]+)").find(f)?.groupValues?.get(1)?.let(::codeFrom) }

    override fun onSaveInstanceState(out: Bundle) { super.onSaveInstanceState(out); out.putString("open", open) }
    override fun onResume() { super.onResume(); resumed = true; engine?.active = open; if (engine == null) boot() }
    override fun onPause() { resumed = false; engine?.active = null; super.onPause() }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }

    @Deprecated("Activity without AndroidX: the back button still comes here")
    override fun onBackPressed() {
        if (open != null) { closeConversation(); return }
        @Suppress("DEPRECATION") super.onBackPressed()
    }

    // ---------- start ----------

    private fun boot() {
        if (!IdentityRequired.check(this)) { showProblem(t("native.noProfile")); return }
        scope.launch {
            try {
                val e = Messenger.boot(this@MainActivity)
                engine = e
                e.active = if (resumed) open else null
                e.onChange = { rerenderSoon() }
                // The bar again, now with the profile (its button shows the account in use).
                setContentView(shell())
                PushService.register(this@MainActivity)
                e.onNotice = { n -> ui.post { onNotice(n) } }
                Messenger.session?.onStatus { ui.post { renderStatus() } }
                if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIF)
                }
                render()
                intent.getStringExtra(Notify.EXTRA_CONTACT)?.let { openConversation(it) }
                pendingCode?.let { if (e.hasNickname) openAdd(it) }
            } catch (e: Messenger.BootError) {
                when (e.code) {
                    "no-identity-app" -> { IdentityRequired.show(this@MainActivity); showProblem(t("native.noProfile")) }
                    "no-profile", "no-profile-keys" -> showProblem(t("native.noProfile"))
                    else -> showProblem(e.message ?: e.code)
                }
            } catch (e: Exception) { showProblem(e.message ?: e.toString()) }
        }
    }

    private fun showProblem(msg: String) {
        val c = content ?: return
        c.removeAllViews()
        c.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(px(32), px(32), px(32), px(32))
            add(label(msg, 16f, col(R.color.m_muted)).apply { gravity = Gravity.CENTER })
            add(pill(t("store.retry"), filled = true) { boot() }.apply { tag = "retry" }, top = 20, width = ViewGroup.LayoutParams.WRAP_CONTENT)
        }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    // ---------- the frame ----------

    private fun shell(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundColor(col(R.color.m_bg))
        fitsSystemWindows = true
        addView(topbar())
        status = label("", 13f, col(R.color.m_muted)).apply { setPadding(px(16), px(6), px(16), px(6)); visibility = View.GONE; setBackgroundColor(col(R.color.m_card2)) }
        addView(status)
        content = FrameLayout(this@MainActivity)
        addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
    }

    private fun topbar(): View {
        val code = label("…", 13f, col(R.color.m_text), bold = true).apply {
            tag = "my-code"; contentDescription = t("topbar.copyCode")
            typeface = android.graphics.Typeface.MONOSPACE
            background = rounded(col(R.color.m_card2), px(14)); setPadding(px(10), px(6), px(10), px(6))
            setOnClickListener { openAdd(null, mine = true) }
        }
        codeChip = code
        val p = Messenger.profile
        return DotrinoTopbar(this, repo = "imdotrino/dotrino-messenger",
            brand = DotrinoTopbar.Brand("Messenger", R.drawable.messenger_brand), actions = listOf(code),
            // The PROFILE, as the web topbar shows it: its name and its avatar (photo or identicon).
            profile = p?.topbar()?.let { if (it.name == null) it.copy(name = engine?.nickname) else it },
        ) { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://dotrino.com/"))) }.view
    }

    private var codeChip: TextView? = null

    private fun renderStatus() {
        val e = engine
        codeChip?.text = e?.pairingCode ?: "…"
        val s = Messenger.session?.status
        status?.apply {
            when (s?.state) {
                "online", null -> visibility = View.GONE
                "connecting" -> { visibility = View.VISIBLE; text = t("native.connecting") }
                else -> { visibility = View.VISIBLE; text = t("native.offline") }
            }
        }
    }

    private fun rerenderSoon() = ui.post {
        if (rerenderQueued) return@post
        rerenderQueued = true
        ui.postDelayed({ rerenderQueued = false; render() }, 60)
    }

    private fun render() {
        val e = engine ?: return
        renderStatus()
        val c = content ?: return
        scope.launch {
            val view = when {
                !e.hasNickname -> nicknameScreen(e)
                open != null -> Conversation(this@MainActivity, e, open!!, ::closeConversation, ::openRate).build()
                else -> listScreen(e)
            }
            c.removeAllViews()
            c.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addSheet?.second?.refresh()
        }
    }

    // ---------- nickname ----------

    private fun nicknameScreen(e: MessengerEngine): View = ScrollView(this).apply {
        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(px(24), px(40), px(24), px(24)); gravity = Gravity.CENTER_HORIZONTAL
            add(ImageView(this@MainActivity).apply { setImageResource(R.drawable.messenger_brand) }, width = px(72))
            add(label("Messenger", 26f, bold = true).apply { gravity = Gravity.CENTER }, top = 12)
            add(label(t("welcome.tagline"), 16f, col(R.color.m_muted)).apply { gravity = Gravity.CENTER }, top = 4)
            val card = card()
            card.add(label(t("welcome.intro"), 15f))
            card.add(label(t("welcome.label"), 13f, col(R.color.m_muted), bold = true), top = 14)
            val input = field(t("welcome.placeholder")).apply { tag = "nickname-input"; imeOptions = EditorInfo.IME_ACTION_DONE }
            card.add(input, top = 6)
            card.add(label(t("welcome.helper"), 13f, col(R.color.m_muted)), top = 8)
            card.add(pill(t("welcome.submit"), filled = true) {
                val n = MessengerEngine.sanitizeNickname(input.text.toString())
                if (n.isNotEmpty()) { e.nickname = n; render(); pendingCode?.let { openAdd(it) } }
            }.apply { tag = "nickname-submit" }, top = 16)
            card.add(label(t("native.welcomeInfo"), 13f, col(R.color.m_muted)), top = 14)
            add(card, top = 24)
        })
    }

    // ---------- the list ----------

    private suspend fun listScreen(e: MessengerEngine): View {
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(px(12), px(12), px(12), px(96)) }
        val reqs = e.requests()
        val incoming = reqs.filter { it.dir == "in" }
        val sent = reqs.filter { it.dir == "out" }
        if (reqs.isNotEmpty()) {
            val box = card()
            box.add(label(t("requests.title") + if (incoming.isNotEmpty()) " · ${incoming.size}" else "", 13f, col(R.color.m_muted), bold = true))
            for (r in incoming) box.add(requestRow(e, r, incoming = true), top = 10)
            for (r in sent) box.add(requestRow(e, r, incoming = false), top = 10)
            col.add(box)
        }
        val contacts = e.contacts().sortedByDescending { c -> e.thread(str(c, "publickey")).lastOrNull()?.let { long(it, "ts") } ?: long(c, "lastSeen") ?: 0 }
        col.add(label(t("sidebar.title"), 18f, bold = true).apply { setPadding(px(4), 0, 0, 0) }, top = if (reqs.isEmpty()) 4 else 20)
        if (contacts.isEmpty()) {
            col.add(label(t("list.emptyBefore") + " " + t("list.emptyPress") + " + " + t("list.emptyAfter"), 15f, col(R.color.m_muted)).apply { gravity = Gravity.CENTER; setPadding(px(16), px(32), px(16), px(16)) })
        }
        for (c in contacts) col.add(contactRow(e, c), top = 8)
        val fab = label("+", 30f, col(R.color.m_on_accent), bold = true).apply {
            gravity = Gravity.CENTER; tag = "add-contact"; contentDescription = t("sidebar.add")
            background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(col(R.color.m_accent)) }
            elevation = px(6).toFloat()
            setOnClickListener { openAdd(null) }
        }
        return FrameLayout(this).apply {
            addView(ScrollView(this@MainActivity).apply { addView(col) }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(fab, FrameLayout.LayoutParams(px(60), px(60), Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, px(20), px(24)) })
        }
    }

    private fun requestRow(e: MessengerEngine, r: MessengerEngine.Request, incoming: Boolean) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        tag = if (incoming) "request-in" else "sent-request"
        val name = r.nickname.ifEmpty { r.pubkey.take(8) + "…" }
        addView(avatar(name, r.pubkey, 36))
        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(px(10), 0, px(8), 0)
            add(label(name + if (incoming && !r.vouched) "  · " + t("requests.stranger") else if (incoming) "  · " + t("requests.vouched") else "", 15f, bold = true))
            add(label(if (incoming) t("requests.defaultMsg") else t("requests.waiting"), 13f, col(R.color.m_muted)))
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        if (incoming) addView(roundAction("✓", col(R.color.m_online), t("requests.accept"), "accept-request") { scope.launch { e.acceptRequest(r.pubkey) } })
        addView(roundAction("✕", col(R.color.m_danger), if (incoming) t("requests.dismiss") else t("requests.cancel"), if (incoming) "dismiss-request" else "cancel-request") {
            scope.launch { e.dismissRequest(r.pubkey, r.dir) }
        })
    }

    private fun roundAction(sym: String, color: Int, desc: String, id: String, run: () -> Unit) = label(sym, 18f, color, bold = true).apply {
        gravity = Gravity.CENTER; contentDescription = desc; tag = id
        background = rounded(col(R.color.m_card), px(20), px(1), col(R.color.m_line2))
        layoutParams = LinearLayout.LayoutParams(px(40), px(40)).apply { leftMargin = px(6) }
        setOnClickListener { run() }
    }

    private fun contactRow(e: MessengerEngine, c: JsonObject): View {
        val pk = str(c, "publickey")
        val name = str(c, "nickname")?.ifEmpty { null } ?: pk.take(8)
        val last = e.thread(pk).lastOrNull()
        val unread = e.unread(pk)
        return LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL; tag = "contact-item"
            background = rounded(col(R.color.m_card), px(16)); setPadding(px(12), px(12), px(12), px(12))
            addView(FrameLayout(this@MainActivity).apply {
                addView(avatar(name, pk))
                if (e.isOnline(pk)) addView(View(this@MainActivity).apply {
                    background = android.graphics.drawable.GradientDrawable().apply { shape = android.graphics.drawable.GradientDrawable.OVAL; setColor(col(R.color.m_online)); setStroke(px(2), col(R.color.m_card)) }
                }, FrameLayout.LayoutParams(px(14), px(14), Gravity.BOTTOM or Gravity.END))
            })
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL; setPadding(px(12), 0, px(8), 0)
                add(label(name, 16f, bold = true).apply { isSingleLine = true })
                add(label(last?.let { str(it, "text") } ?: t("list.noMessages"), 14f, col(R.color.m_muted)).apply { isSingleLine = true; ellipsize = android.text.TextUtils.TruncateAt.END })
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL; gravity = Gravity.END
                last?.let { add(label(clock(long(it, "ts") ?: 0), 12f, col(R.color.m_muted))) }
                if (unread > 0) add(label("$unread", 12f, col(R.color.m_on_accent), bold = true).apply {
                    gravity = Gravity.CENTER; background = rounded(col(R.color.m_accent), px(10)); setPadding(px(7), px(1), px(7), px(1))
                }, top = 4, width = ViewGroup.LayoutParams.WRAP_CONTENT)
            })
            setOnClickListener { openConversation(pk) }
        }
    }

    // ---------- navigation ----------

    fun openConversation(pk: String) {
        open = pk
        engine?.active = if (resumed) pk else null
        notify.clear(pk)
        scope.launch { engine?.markRead(pk); engine?.sendHelloTo(pk) }
        render()
    }

    private fun closeConversation() { open = null; engine?.active = null; render() }

    /** «Add contact»; [mine] = straight to «My code» (the chip of the bar: to show mine, not type theirs). */
    private fun openAdd(code: String?, mine: Boolean = false) {
        val e = engine ?: return
        pendingCode = null
        addSheet?.first?.dismiss()
        val s = AddSheet(this, e, code, ::openScanner, if (mine) "mine" else "add")
        addSheet = s.dialog to s
        s.dialog.setOnDismissListener { if (addSheet?.second === s) addSheet = null }
        s.dialog.show()
    }

    private fun openRate(pk: String) {
        val e = engine ?: return
        RateSheet(this, e, pk).show()
    }

    private fun onNotice(n: MessengerEngine.Notice) {
        // On screen and in that conversation: nothing to announce.
        if (resumed && n.kind == "message" && open == n.fromPubkey) return
        notify.show(n)
    }

    // ---------- scanning ----------

    private fun openScanner() {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA); return
        }
        val view = QrScanView(this)
        val d = Dialog(this, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
        d.setContentView(FrameLayout(this).apply {
            addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(label(t("native.scanTitle"), 18f, 0xFFFFFFFF.toInt(), bold = true).apply { setPadding(px(20), px(20), px(20), px(20)) }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
            addView(pill(t("add.close")) { d.dismiss() }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = px(40) })
        })
        d.setOnDismissListener { view.stop(); scanDialog = null }
        scanDialog = d
        d.show()
        view.start(onResult = { text -> d.dismiss(); onScanned(text) }, onError = { code ->
            d.dismiss()
            if (code == "no-camera-permission" || code == "no-camera") pickPhoto() else toast(code)
        })
    }

    private fun pickPhoto() {
        toast(t("native.cameraDenied"))
        startActivityForResult(Intent(MediaStore.ACTION_PICK_IMAGES).apply { type = "image/*" }, REQ_PHOTO)
    }

    private fun onScanned(text: String) {
        val code = codeFrom(text)
        addSheet?.second?.scanned(if (Regex(CODE_RE).matches(code)) code else null)
    }

    @Deprecated("Activity without AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PHOTO || resultCode != RESULT_OK) return
        val uri = data?.data ?: return
        val bmp = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } ?: return
        val text = DotrinoQr.decode(bmp)
        if (text == null) addSheet?.second?.scanned(null) else onScanned(text)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAMERA) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) openScanner() else pickPhoto()
        }
    }

    // ---------- small ----------

    fun clock(ts: Long): String {
        val d = Date(ts)
        val sameDay = SimpleDateFormat("yyyyMMdd", Locale.ROOT).let { it.format(d) == it.format(Date()) }
        return SimpleDateFormat(if (sameDay) "HH:mm" else "dd/MM HH:mm", Locale.getDefault()).format(d)
    }

    fun launch(block: suspend () -> Unit) = scope.launch { block() }
}

fun str(o: JsonObject?, k: String): String = (o?.get(k) as? JsonPrimitive)?.takeIf { it.isString }?.content ?: ""
fun long(o: JsonObject?, k: String): Long? = (o?.get(k) as? JsonPrimitive)?.content?.toLongOrNull()
