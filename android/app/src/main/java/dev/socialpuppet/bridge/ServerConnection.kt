package dev.socialpuppet.bridge

import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * WebSocket client: connects OUT to the social-puppet server, responds to pings,
 * routes `cmd` messages to [onCommand], reconnects with exponential backoff.
 * All callbacks arrive on OkHttp's thread; [onCommand] is delivered on the main
 * looper so the service can touch the accessibility framework safely.
 */
class ServerConnection(
    private val onCommand: (cmd: String, params: JSONObject, cmdId: String) -> Unit,
    private val onStatus: (String) -> Unit,
    private val onOpen: () -> Unit,
) {
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var reconnectAttempt = 0
    private var stopped = false

    fun connect(url: String) {
        this.url = url
        stopped = false
        open(url)
    }

    private fun open(url: String) {
        if (stopped) return
        onStatus(if (reconnectAttempt == 0) "connecting…" else "reconnecting (attempt $reconnectAttempt)…")
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, listener)
    }

    private fun scheduleReconnect() {
        if (stopped) return
        val delay = 2000L shl minOf(reconnectAttempt, 5).coerceAtLeast(0)
        reconnectAttempt += 1
        onStatus("disconnected — reconnecting in ${delay / 1000}s")
        mainHandler.postDelayed({ open(url) }, delay)
    }

    private var url: String = ""

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            reconnectAttempt = 0
            onStatus("connected")
            onOpen()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            try {
                val msg = JSONObject(text)
                when (msg.optString("type")) {
                    "ping" -> webSocket.send("""{"type":"pong"}""")
                    "cmd" -> {
                        val cmdId = msg.optString("cmdId")
                        val cmd = msg.optString("cmd")
                        val params = msg.optJSONObject("params") ?: JSONObject()
                        Log.i(TAG, "cmd received: $cmd ($cmdId)")
                        mainHandler.post { onCommand(cmd, params, cmdId) }
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "bad ws message", e)
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "ws failure: ${t.message}")
            scheduleReconnect()
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            scheduleReconnect()
        }
    }

    fun send(text: String) {
        ws?.send(text)
    }

    fun sendResult(cmdId: String, ok: Boolean, result: JSONObject? = null, error: String? = null) {
        val o = JSONObject()
        o.put("type", "result")
        o.put("cmdId", cmdId)
        o.put("ok", ok)
        if (result != null) o.put("result", result)
        if (error != null) o.put("error", error)
        ws?.send(o.toString())
    }

    fun close() {
        stopped = true
        mainHandler.removeCallbacksAndMessages(null)
        ws?.close(1000, "bridge stopped")
        ws = null
    }

    companion object {
        private const val TAG = "ServerConnection"
    }
}
