package dev.socialpuppet.bridge

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat

/** Status + launcher for setup and the accessibility settings screen. */
class MainActivity : ComponentActivity() {

    private val statusText by lazy { TextView(this).apply { textSize = 16f } }

    private val notifPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Config.init(this)
        requestNotificationPermissionIfNeeded()
        setContentView(buildUi())
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    private fun refreshStatus() {
        val enabled = isAccessibilityEnabled()
        statusText.text =
            buildString {
                appendLine("device id: ${Config.deviceId}")
                appendLine("server:    ${Config.serverUrl}")
                appendLine("token:     ${if (Config.token.isBlank()) "(none)" else "set"}")
                appendLine("a11y:      ${if (enabled) "ENABLED" else "disabled"}")
                appendLine("bridge:    ${BridgeService.status}")
                if (!enabled) {
                    appendLine()
                    append("Enable the accessibility service below to start the bridge.")
                }
            }
    }

    private fun isAccessibilityEnabled(): Boolean {
        val expected = "$packageName/${BridgeService::class.java.name}"
        val enabled = Settings.Secure.getString(
            contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: ""
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) notifPermLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun buildUi(): LinearLayout {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 64, 32, 32)
        }
        val title = TextView(this).apply {
            text = "social-puppet bridge"
            textSize = 24f
        }
        root.addView(title)
        root.addView(statusText)

        root.addView(
            Button(this).apply {
                text = "Setup (server URL / token)"
                setOnClickListener {
                    startActivity(Intent(this@MainActivity, SetupActivity::class.java))
                }
            },
        )
        root.addView(
            Button(this).apply {
                text = "Accessibility settings"
                setOnClickListener {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                }
            },
        )
        root.addView(
            Button(this).apply {
                text = "Refresh status"
                setOnClickListener { refreshStatus() }
            },
        )
        return root
    }
}
