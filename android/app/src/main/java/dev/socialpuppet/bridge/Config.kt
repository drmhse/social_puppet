package dev.socialpuppet.bridge

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import java.net.URLEncoder
import java.util.UUID

/** App configuration: server URL, token, device identity. */
object Config {
    private const val PREFS = "social_puppet"
    private const val KEY_SERVER = "server_url"
    private const val KEY_TOKEN = "token"
    private const val KEY_NAME = "device_name"
    private const val KEY_DEVICE_ID = "device_id"
    private const val KEY_SCREEN_TIMEOUT = "screen_timeout_ms"

    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        if (::prefs.isInitialized) return
        prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    }

    var serverUrl: String
        get() = prefs.getString(KEY_SERVER, "ws://192.168.1.10:8743")!!
        set(v) = prefs.edit().putString(KEY_SERVER, v.trim()).apply()

    var token: String
        get() = prefs.getString(KEY_TOKEN, "")!!
        set(v) = prefs.edit().putString(KEY_TOKEN, v.trim()).apply()

    var deviceName: String
        get() = prefs.getString(KEY_NAME, Build.MODEL)!!
        set(v) = prefs.edit().putString(KEY_NAME, v.trim()).apply()

    val deviceId: String
        get() {
            prefs.getString(KEY_DEVICE_ID, null)?.let { return it }
            val id = "android-" + UUID.randomUUID().toString().take(8)
            prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            return id
        }

    fun screenTimeoutMs(): Int = prefs.getInt(KEY_SCREEN_TIMEOUT, 0)

    fun setScreenTimeoutMs(ms: Int) = prefs.edit().putInt(KEY_SCREEN_TIMEOUT, ms).apply()

    fun wsUrl(): String {
        val base = serverUrl.trim().removeSuffix("/")
        val url = if (base.startsWith("ws://") || base.startsWith("wss://")) base else "ws://$base"
        return if (token.isBlank()) url else "$url/?token=${URLEncoder.encode(token, "UTF-8")}"
    }
}
