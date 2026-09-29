package com.dotrino.messenger

import com.dotrino.messenger.engine.Kv
import com.dotrino.messenger.engine.MemoryKv
import com.dotrino.messenger.engine.MemoryThreads
import com.dotrino.messenger.engine.MessengerEngine
import com.dotrino.messenger.engine.Transport
import com.dotrino.sdk.Crypto
import com.dotrino.sdk.DeviceKeys
import com.dotrino.sdk.IdentitySealing
import com.dotrino.sdk.PeerBook
import com.dotrino.sdk.Profile
import com.dotrino.sdk.ProxyConnection
import com.dotrino.sdk.SealedSession
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.KeyAgreement

/**
 * The messenger's rules, with REAL engines and REAL sealing over an in-memory proxy:
 * a request never touches a chat, nobody is a contact until accepted, strangers and forged
 * senders go nowhere.
 */
class EngineTest {
    private class SoftKeys : DeviceKeys {
        private fun pair() = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        private val s = pair(); private val e = pair()
        override val publickey = Crypto.jwkOf(s.public as ECPublicKey)
        override val encPub = Crypto.jwkOf(e.public as ECPublicKey)
        override suspend fun sign(text: String): String {
            val g = Signature.getInstance("SHA256withECDSA"); g.initSign(s.private as PrivateKey); g.update(text.toByteArray())
            return Crypto.b64(Crypto.derToP1363(g.sign()))
        }
        override suspend fun agree(peer: PublicKey): ByteArray {
            val k = KeyAgreement.getInstance("ECDH"); k.init(e.private); k.doPhase(peer, true); return k.generateSecret()
        }
    }

    /** The proxy, in memory: tokens, pubkeys, announced keys, codes. Everything sealed for real. */
    private class Net {
        val byToken = HashMap<String, Phone>()
        val codes = HashMap<String, String>()
        var codeTtl = 60_000L
        var codeCalls = 0
        inner class Phone(val name: String) : Transport {
            val keys = SoftKeys()
            val profile = Profile.of(keys)
            val token = "T-$name"
            val sealing = IdentitySealing(profile, "messenger")
            val listeners = CopyOnWriteArrayList<(SealedSession.Message) -> Unit>()
            init { byToken[token] = this }
            private suspend fun deliverTo(to: Phone, payload: JsonObject, keys: List<String>) {
                val env = sealing.seal(payload, keys.ifEmpty { listOf(to.profile.encPub) })
                val opened = runCatching { to.sealing.open(env) }.getOrNull() ?: return
                val m = SealedSession.Message(token, profile.publickey, opened.payload, opened.senderEncPub, false, null)
                to.listeners.forEach { it(m) }
            }
            /** A message that claims to be from [claimed] but is sealed by this phone. */
            suspend fun forge(to: Phone, claimed: String, payload: JsonObject) {
                val env = sealing.seal(payload, listOf(to.profile.encPub))
                val o = to.sealing.open(env)
                to.listeners.forEach { it(SealedSession.Message(token, claimed, o.payload, o.senderEncPub, false, null)) }
            }
            suspend fun raw(to: Phone, payload: JsonObject) = deliverTo(to, payload, emptyList())
            override suspend fun sendSealedTo(token: String, payload: JsonObject, recipientEncPubs: List<String>) = deliverTo(byToken.getValue(token), payload, recipientEncPubs)
            override suspend fun sendSealed(pubkey: String, payload: JsonObject, recipientEncPubs: List<String>, quiet: Boolean) =
                deliverTo(byToken.values.first { it.profile.publickey == pubkey }, payload, recipientEncPubs)
            override suspend fun encPubOf(publickey: String) = byToken.values.first { it.profile.publickey == publickey }.profile.encPub
            override fun pubkeyOfToken(token: String) = byToken[token]?.profile?.publickey
            override suspend fun whoIs(token: String) = pubkeyOfToken(token)
            override suspend fun requestPairingCode(): ProxyConnection.PairingCode {
                codeCalls++
                val c = "C" + name.uppercase().take(5).padEnd(5, 'X'); codes[c] = token
                return ProxyConnection.PairingCode(c, System.currentTimeMillis() + codeTtl)
            }
            override suspend fun redeemPairingCode(code: String) = codes.remove(code) ?: throw ProxyConnection.ProxyError("bad code", "pair-invalid")
            override val isOnline = true
            override fun onMessage(l: (SealedSession.Message) -> Unit): () -> Unit { listeners.add(l); return { listeners.remove(l) } }
            override fun onOnline(l: () -> Unit): () -> Unit = {}
            override fun onPeerGone(l: (String) -> Unit): () -> Unit = {}
        }
    }

    private class Person(net: Net, name: String) {
        val phone = net.Phone(name)
        val kv: Kv = MemoryKv()
        val threads = MemoryThreads()
        val peers = PeerBook(PeerBook.MemoryStorage(), phone.profile)
        val engine = MessengerEngine(phone, phone.profile, peers, threads, kv, "0.3.0").also { it.nickname = name; it.start() }
        val notices = CopyOnWriteArrayList<MessengerEngine.Notice>()
        init { engine.onNotice = { notices.add(it) } }
        val pubkey get() = phone.profile.publickey
    }

    private suspend fun until(what: String, f: suspend () -> Boolean) = withTimeout(5_000) { while (!f()) delay(20) }.also { assertTrue(what, f()) }

    @Test fun aRequestIsControlNotChatAndAcceptMakesContactsOnBothSides() = runBlocking {
        val net = Net(); val ana = Person(net, "Ana"); val beto = Person(net, "Beto")
        until("ana has a code") { ana.engine.pairingCode != null }
        beto.engine.addByCode(ana.engine.pairingCode!!, "Anita")

        until("ana gets the request") { ana.engine.requests().any { it.dir == "in" && it.pubkey == beto.pubkey } }
        assertEquals("request", ana.notices.single().kind)
        // Nothing in any chat, and nobody is a contact yet.
        assertTrue(ana.threads.threads().isEmpty()); assertTrue(beto.threads.threads().isEmpty())
        assertTrue(ana.engine.contacts().isEmpty()); assertTrue(beto.engine.contacts().isEmpty())
        assertEquals("out", beto.engine.requests().single().dir)

        ana.engine.acceptRequest(beto.pubkey)
        until("beto sees ana as a contact") { beto.engine.contacts().any { it["publickey"]!!.jsonPrimitive.content == ana.pubkey } }
        assertEquals("Anita", beto.engine.contacts().single()["nickname"]!!.jsonPrimitive.content) // the alias Beto chose
        assertTrue(ana.engine.requests().isEmpty()); assertTrue(beto.engine.requests().isEmpty())

        beto.engine.sendDM(ana.pubkey, "hola ana & ñ <b>")
        until("ana reads it") { ana.engine.thread(beto.pubkey).any { it["text"]!!.jsonPrimitive.content == "hola ana & ñ <b>" } }
        assertEquals(1, ana.engine.thread(beto.pubkey).size)   // only the message; the request left no trace
        until("the ack reaches beto") { beto.engine.thread(ana.pubkey).single()["pending"]!!.jsonPrimitive.content == "false" }
    }

    @Test fun aStrangersMessageGoesNowhere() = runBlocking {
        val net = Net(); val ana = Person(net, "Ana"); val carla = Person(net, "Carla")
        carla.phone.raw(ana.phone, buildJsonObject { put("type", "DM"); put("text", "hola"); put("mid", "m1"); put("ts", 1) })
        delay(300)
        assertTrue(ana.threads.threads().isEmpty()); assertTrue(ana.engine.requests().isEmpty()); assertTrue(ana.notices.isEmpty())
    }

    @Test fun anAcceptNobodyAskedForAddsNobody() = runBlocking {
        val net = Net(); val ana = Person(net, "Ana"); val carla = Person(net, "Carla")
        carla.phone.raw(ana.phone, buildJsonObject { put("type", "CONTACT_ACCEPT"); put("nickname", "Carla") })
        delay(300)
        assertTrue(ana.engine.contacts().isEmpty())
    }

    @Test fun aForgedSenderIsDropped() = runBlocking {
        val net = Net(); val ana = Person(net, "Ana"); val beto = Person(net, "Beto"); val eve = Person(net, "Eve")
        until("code") { ana.engine.pairingCode != null }
        beto.engine.addByCode(ana.engine.pairingCode!!, "")
        until("request") { ana.engine.requests().isNotEmpty() }
        ana.engine.acceptRequest(beto.pubkey)
        until("contacts") { beto.engine.contacts().isNotEmpty() }
        // Eve seals with HER key but claims to be Beto: the key does not belong to Beto.
        eve.phone.forge(ana.phone, beto.pubkey, buildJsonObject { put("type", "DM"); put("text", "soy beto"); put("mid", "f1"); put("ts", 1) })
        delay(300)
        assertTrue(ana.engine.thread(beto.pubkey).none { it["text"]!!.jsonPrimitive.content == "soy beto" })
    }

    @Test fun theCodeRenewsItselfAndNeverGoesEmpty() = runBlocking {
        val net = Net(); net.codeTtl = 10_300   // renewed 5 s before it expires: ~5.3 s from now
        val ana = Person(net, "Ana")
        until("first code") { ana.engine.pairingCode != null }
        val before = net.codeCalls
        withTimeout(12_000) { while (net.codeCalls == before) delay(100) }
        delay(300)
        assertTrue("the renewal left the code empty", ana.engine.pairingCode != null)
    }

    @Test fun bothAskingIsBothAccepting() = runBlocking {
        val net = Net(); val ana = Person(net, "Ana"); val beto = Person(net, "Beto")
        until("codes") { ana.engine.pairingCode != null && beto.engine.pairingCode != null }
        beto.engine.addByCode(ana.engine.pairingCode!!, "")
        until("ana has the request") { ana.engine.requests().isNotEmpty() }
        // Ana, instead of accepting, adds Beto by his code: that is accepting.
        ana.engine.addByCode(beto.engine.pairingCode!!, "")
        until("both are contacts") { ana.engine.contacts().isNotEmpty() && beto.engine.contacts().isNotEmpty() }
    }
}
