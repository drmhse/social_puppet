package dev.socialpuppet.bridge

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity

/** Configure server URL + token + device name, and optionally extend the screen timeout. */
class SetupActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Config.init(this)
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        maybeApplyScreenTimeout()
    }

    private fun buildUi(): LinearLayout {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 64, 32, 32)
        }

        root.addView(TextView(this).apply { text = "Server URL"; textSize = 18f })
        val serverInput = EditText(this).apply { setText(Config.serverUrl) }
        root.addView(serverInput)

        root.addView(TextView(this).apply { text = "Token (leave empty if server has none)" })
        val tokenInput = EditText(this).apply { setText(Config.token) }
        root.addView(tokenInput)

        root.addView(TextView(this).apply { text = "Device name (shown to pi)" })
        val nameInput = EditText(this).apply { setText(Config.deviceName) }
        root.addView(nameInput)

        root.addView(
            Button(this).apply {
                text = "Save"
                setOnClickListener {
                    Config.serverUrl = serverInput.text.toString()
                    Config.token = tokenInput.text.toString()
                    Config.deviceName = nameInput.text.toString()
                    finish()
                }
            },
        )

        root.addView(TextView(this).apply {
            text = "Note: after saving, enable the bridge in Accessibility settings "
                .plus("(Main screen → Accessibility settings). The bridge reconnects automatically.")
            textSize = 14f
        })

        root.addView(
            Button(this).apply {
                text = "Extend screen timeout to 30 min (recommended)"
                setOnClickListener { requestScreenTimeoutPermission() }
            },
        )

        return root
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
            Toast.makeText(this, "Screen timeout set to 30 min", Toast.LENGTH_SHORT).show()
        }
    }
}
