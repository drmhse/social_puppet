package dev.socialpuppet.bridge

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton

/** Status + launcher for setup, the accessibility settings screen, and battery
 *  optimization (so the bridge survives backgrounding). */
class MainActivity : ComponentActivity() {

    private lateinit var statusText: TextView
    private lateinit var logText: TextView
    private lateinit var batteryBtn: MaterialButton

    private val notifPermLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Config.init(this)
        requestNotificationPermissionIfNeeded()
        setContentView(R.layout.activity_main)

        statusText = findViewById(R.id.statusText)
        logText = findViewById(R.id.logText)
        batteryBtn = findViewById(R.id.batteryBtn)

        findViewById<MaterialButton>(R.id.setupBtn).setOnClickListener {
            startActivity(Intent(this, SetupActivity::class.java))
        }
        findViewById<MaterialButton>(R.id.a11yBtn).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<MaterialButton>(R.id.batteryBtn).setOnClickListener {
            requestIgnoreBatteryOptimizations()
        }
        findViewById<MaterialButton>(R.id.refreshBtn).setOnClickListener { refresh() }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        statusText.text = buildString {
            appendLine("device id: ${Config.deviceId}")
            appendLine("server:    ${Config.serverUrl}")
            appendLine("token:     ${if (Config.token.isBlank()) "(none)" else "set"}")
            appendLine("a11y:      ${if (isAccessibilityEnabled()) "ENABLED" else "disabled"}")
            appendLine("bridge:    ${BridgeService.status}")
            val b = BridgeService.battery
            appendLine(
                "battery:   ${if (b != null) "$b%${if (BridgeService.charging) " (charging)" else ""}" else "unknown"}",
            )
            appendLine("battery opt: ${if (isIgnoringBatteryOptimizations()) "exempt" else "not exempt"}")
            if (!isAccessibilityEnabled()) {
                appendLine()
                append("Enable the accessibility service below to start the bridge.")
            }
        }
        // The battery button mirrors the exemption state.
        if (isIgnoringBatteryOptimizations()) {
            batteryBtn.text = "Background battery use: allowed"
            batteryBtn.setIconResource(android.R.drawable.presence_online)
        } else {
            batteryBtn.text = "Allow background battery use"
            batteryBtn.setIconResource(android.R.drawable.ic_menu_help)
        }
        logText.text = BridgeService.logSnapshot().joinToString("\n")
            .ifEmpty { "— nothing logged yet —" }
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

    private fun requestIgnoreBatteryOptimizations() {
        if (isIgnoringBatteryOptimizations()) {
            Toast.makeText(this, "Background battery use already allowed", Toast.LENGTH_SHORT).show()
            return
        }
        startActivity(
            Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"),
            ),
        )
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }
}
