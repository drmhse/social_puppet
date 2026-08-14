package dev.socialpuppet.bridge

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Configure server URL + token + device name, test the connection, and optionally
 *  extend the screen timeout. */
class SetupActivity : ComponentActivity() {

    private val http = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private lateinit var serverInput: TextInputEditText
    private lateinit var tokenInput: TextInputEditText
    private lateinit var nameInput: TextInputEditText
    private lateinit var testResult: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Config.init(this)
        setContentView(R.layout.activity_setup)

        serverInput = findViewById(R.id.serverInput)
        tokenInput = findViewById(R.id.tokenInput)
        nameInput = findViewById(R.id.nameInput)
        testResult = findViewById(R.id.testResult)

        serverInput.setText(Config.serverUrl)
        tokenInput.setText(Config.token)
        nameInput.setText(Config.deviceName)

        findViewById<MaterialButton>(R.id.saveBtn).setOnClickListener {
            val before = listOf(Config.serverUrl, Config.token, Config.deviceName)
            Config.serverUrl = serverInput.text.toString()
            Config.token = tokenInput.text.toString()
            Config.deviceName = nameInput.text.toString()
            val after = listOf(Config.serverUrl, Config.token, Config.deviceName)
            // A running bridge holds the old URL for the life of its socket, so make it
            // drop that socket and dial the new one.
            if (before != after && BridgeService.applyConfigChange()) {
                android.widget.Toast.makeText(
                    this,
                    "Saved — reconnecting the bridge",
                    android.widget.Toast.LENGTH_SHORT,
                ).show()
            }
            finish()
        }
        findViewById<MaterialButton>(R.id.testBtn).setOnClickListener { testConnection() }
        findViewById<MaterialButton>(R.id.timeoutBtn).setOnClickListener {
            requestScreenTimeoutPermission()
        }
    }

    override fun onResume() {
        super.onResume()
        maybeApplyScreenTimeout()
    }

    private fun testConnection() {
        val url = serverInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()
        val httpUrl = Config.httpFromWs(url)
        testResult.setTextColor(ContextCompat.getColor(this, R.color.warn_amber))
        testResult.text = "Testing $httpUrl/health …"
        val req = Request.Builder()
            .url("$httpUrl/health")
            .apply { if (token.isNotBlank()) header("Authorization", "Bearer $token") }
            .build()
        http.newCall(req).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                runOnUiThread {
                    testResult.setTextColor(ContextCompat.getColor(this@SetupActivity, R.color.err_red))
                    testResult.text = "Unreachable: ${e.message}"
                }
            }

            override fun onResponse(call: Call, response: Response) {
                val body = response.body?.string().orEmpty()
                runOnUiThread {
                    when {
                        response.code == 200 && body.contains("\"ok\":true") ->
                            testResult.setTextColor(
                                ContextCompat.getColor(this@SetupActivity, R.color.ok_green),
                            ).also {
                                testResult.text = if (token.isBlank()) {
                                    "Connected. Note: server is running OPEN (no token)."
                                } else {
                                    "Connected, auth OK."
                                }
                            }

                        response.code == 401 ->
                            testResult.setTextColor(
                                ContextCompat.getColor(this@SetupActivity, R.color.err_red),
                            ).also { testResult.text = "Server reachable but token rejected (401)." }

                        else ->
                            testResult.setTextColor(
                                ContextCompat.getColor(this@SetupActivity, R.color.err_red),
                            ).also { testResult.text = "HTTP ${response.code}: ${body.take(120)}" }
                    }
                }
                response.close()
            }
        })
    }

    private fun requestScreenTimeoutPermission() {
        if (!Settings.System.canWrite(this)) {
            startActivity(
                Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:$packageName")),
            )
            return
        }
        applyScreenTimeout()
    }

    private fun maybeApplyScreenTimeout() {
        if (Settings.System.canWrite(this) && Config.screenTimeoutMs() == 0) {
            applyScreenTimeout()
        }
    }

    private fun applyScreenTimeout() {
        val ms = 30 * 60 * 1000
        val ok = Settings.System.putInt(contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, ms)
        if (ok) {
            Config.setScreenTimeoutMs(ms)
            android.widget.Toast.makeText(this, "Screen timeout set to 30 min", android.widget.Toast.LENGTH_SHORT).show()
        }
    }
}
