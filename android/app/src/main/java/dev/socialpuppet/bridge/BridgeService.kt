package dev.socialpuppet.bridge

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Path
import android.graphics.Rect
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.FileProvider
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okio.source
import org.json.JSONObject
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The bridge: an AccessibilityService that dumps the current screen as a text
 * tree, pushes it over the server connection, and executes commands (tap, type,
 * swipe, keys, launch, panic) against the live UI.
 *
 * Lifecycle: enabling the service in Settings calls onServiceConnected → we start
 * a foreground notification and connect to the server. Disabling stops it.
 */
class BridgeService : AccessibilityService() {

    private val mainHandler = Handler(Looper.getMainLooper())
    private val gestureThread = HandlerThread("gesture").apply { start() }
    private val gestureHandler = Handler(gestureThread.looper)
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // big files; the command watchdog bounds us
        .build()
    private var connection: ServerConnection? = null
    /** Content hash of the last tree we pushed — see [DumpBudget]. */
    private var lastTreeHash = 0L
    private var lastDumpAt = 0L
    private var dumpScheduled = false
    private val executor = CommandExecutor()
    private var started = false

    companion object {
        private const val TAG = "BridgeService"
        private const val CHANNEL_ID = "bridge"
        private const val NOTIF_ID = 1

        /** Floor between tree dumps. Tight enough that a controller polling after a
         *  tap sees the new screen quickly, loose enough that an animation can't
         *  turn into a dump-per-frame. */
        private const val MIN_DUMP_INTERVAL_MS = 300L

        /** Commands that only read — they can run while a gesture is still in
         *  flight instead of queueing behind it. */
        private val READ_ONLY_CMDS = setOf("refresh", "screenshot", "getFile")

        /** Scroll/scrollTo directions, named for how you move THROUGH the content
         *  ("down" = further down the feed). */
        private val DIRECTIONS = setOf("up", "down", "left", "right")

        @Volatile
        var status: String = "service not running"

        @Volatile
        var lastLaunchError: String? = null

        @Volatile
        var battery: Int? = null

        @Volatile
        var charging = false

        /** The live service, if enabled — so setup can push config changes into it. */
        @Volatile
        private var instance: BridgeService? = null

        /** Drop the current socket and reconnect using the freshly saved server URL /
         *  token / device name. No-op when the service isn't enabled. */
        fun applyConfigChange(): Boolean {
            val svc = instance ?: return false
            svc.mainHandler.post { svc.reconnect() }
            return true
        }

        private val activityLog = ArrayDeque<String>()

        fun log(s: String) {
            synchronized(activityLog) {
                activityLog.addLast(java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US).format(java.util.Date()) + "  " + s)
                while (activityLog.size > 30) activityLog.removeFirst()
            }
        }

        fun logSnapshot(): List<String> = synchronized(activityLog) { activityLog.toList() }
    }

    // ------------------------------------------------------------------ lifecycle

    override fun onServiceConnected() {
        super.onServiceConnected()
        Config.init(this)
        instance = this
        startForegroundWithNotification()
        started = true
        openConnection()
        mainHandler.postDelayed(statusTick, 60_000)
    }

    /** Build a fresh [ServerConnection] against the current config and connect.
     *  A closed ServerConnection can't be reused, so this always makes a new one. */
    private fun openConnection() {
        lastTreeHash = 0L
        connection = ServerConnection(
            onCommand = { cmd, params, cmdId ->
                executor.enqueue(cmd, params, cmdId, watchdogFor(cmd, params))
            },
            onStatus = { s ->
                status = s
                log(s)
            },
            onOpen = {
                mainHandler.post {
                    sendHello()
                    sendStatusNow()
                    pushTree(force = true)
                }
            },
        )
        connection?.connect(Config.wsUrl())
        status = "connecting…"
        log("connecting to ${Config.serverUrl} as ${Config.deviceName}")
    }

    /** Tear the socket down and reopen against the current config. */
    private fun reconnect() {
        if (!started) return
        log("config changed — reconnecting")
        executor.clear()
        connection?.close()
        connection = null
        updateNotification()
        openConnection()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || !started) return
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                sendEvent("window", event.packageName?.toString(), event.className?.toString())
                scheduleDump(80)
            }
            AccessibilityEvent.TYPE_WINDOWS_CHANGED -> scheduleDump(200)
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED -> scheduleDump(400)
        }
    }

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        started = false
        instance = null
        mainHandler.removeCallbacks(statusTick)
        executor.clear()
        connection?.close()
        connection = null
        status = "service not running"
        log("service stopped")
        gestureThread.quitSafely()
        super.onDestroy()
    }

    // ------------------------------------------------------------------ notification

    private fun startForegroundWithNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Bridge status", NotificationManager.IMPORTANCE_LOW),
        )
        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            buildNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
    }

    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_bridge_small)
            .setContentTitle("social-puppet bridge")
            .setContentText("server: ${Config.serverUrl}")
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .build()
    }

    /** Refresh the ongoing notification so it shows the current server. */
    private fun updateNotification() {
        getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification())
    }

    // ------------------------------------------------------------------ screen pushing

    /** Coalesce dump requests: one in flight, and never more often than
     *  [MIN_DUMP_INTERVAL_MS]. An animating screen fires content-changed events
     *  continuously; without a floor, every frame would walk the whole tree. */
    private fun scheduleDump(delayMs: Long) {
        if (!started || dumpScheduled) return
        val sinceLast = System.currentTimeMillis() - lastDumpAt
        val wait = maxOf(delayMs, MIN_DUMP_INTERVAL_MS - sinceLast)
        dumpScheduled = true
        mainHandler.postDelayed({
            dumpScheduled = false
            pushTree(force = false)
        }, wait)
    }

    /** Dump every interactive window and push the result. [force] bypasses content
     *  dedup (used for refresh and on connect).
     *
     *  The active window comes first — controllers read the head of the dump as
     *  "the screen" — then the IME, system dialogs, the notification shade and any
     *  split-screen partner, each tagged with its window so they can be told apart.
     *  `rootInActiveWindow` alone sees none of those. */
    private fun pushTree(force: Boolean) {
        if (!started) return
        val conn = connection ?: return
        // No socket → no reader. Walking the tree costs a binder round-trip per
        // node, so don't pay it for a dump nobody will receive.
        if (!conn.isOpen()) return
        lastDumpAt = System.currentTimeMillis()
        try {
            val (sw, sh) = screenSize()
            val screenRect = Rect(0, 0, sw, sh)
            val budget = DumpBudget()
            val roots = ArrayList<Node>()
            val windowMeta = ArrayList<JSONObject>(4)
            var activeId = -1
            var activePkg: String? = null

            val active = rootInActiveWindow
            if (active != null) {
                activeId = active.windowId
                activePkg = active.packageName?.toString()
                val tag = WindowTag(activeId, "active", true, activePkg)
                roots.addAll(TreeDumper.dump(active, budget, tag, screenRect))
                windowMeta.add(windowMetaJson(tag, budget.count))
            }
            for (w in safeWindows()) {
                if (w.id == activeId) continue
                val root = w.root ?: continue
                val before = budget.count
                val tag = WindowTag(w.id, windowTypeName(w.type), w.isActive, root.packageName?.toString())
                roots.addAll(TreeDumper.dump(root, budget, tag, screenRect))
                if (budget.count > before) windowMeta.add(windowMetaJson(tag, budget.count - before))
            }
            if (roots.isEmpty()) return

            // Dedup on CONTENT, before serializing. The hash is accumulated during
            // the walk we already had to do, so an unchanged screen costs nothing
            // beyond that walk — no JSON, no big string, no socket write. (The old
            // code compared a JSON string that already contained a timestamp, so it
            // never matched and every event pushed a full tree.)
            budget.mix(sw)
            budget.mix(sh)
            if (!force && budget.hash == lastTreeHash) return
            lastTreeHash = budget.hash

            val sb = StringBuilder(TreeDumper.estimateChars(budget.count))
            sb.append("{\"type\":\"tree\",\"seq\":").append(System.currentTimeMillis())
            sb.append(",\"pkg\":")
                .append(if (activePkg == null) "null" else JSONObject.quote(activePkg))
            sb.append(",\"nodeCount\":").append(budget.count)
            sb.append(",\"truncated\":").append(budget.truncated)
            sb.append(",\"screen\":").append(screenJson())
            sb.append(",\"windows\":[")
            for (i in windowMeta.indices) {
                if (i > 0) sb.append(',')
                sb.append(windowMeta[i])
            }
            sb.append("],\"nodes\":")
            TreeDumper.appendNodes(sb, roots)
            sb.append('}')
            conn.send(sb.toString())
        } catch (e: Throwable) {
            Log.w(TAG, "pushTree failed", e)
        }
    }

    /** `windows` throws if the service has been torn down mid-dump. */
    private fun safeWindows(): List<AccessibilityWindowInfo> =
        try {
            windows ?: emptyList()
        } catch (e: Throwable) {
            emptyList()
        }

    private fun windowMetaJson(tag: WindowTag, nodes: Int): JSONObject =
        JSONObject()
            .put("id", tag.id)
            .put("type", tag.type)
            .put("active", tag.active)
            .put("pkg", tag.pkg ?: JSONObject.NULL)
            .put("nodes", nodes)

    private fun windowTypeName(type: Int): String = when (type) {
        AccessibilityWindowInfo.TYPE_APPLICATION -> "application"
        AccessibilityWindowInfo.TYPE_INPUT_METHOD -> "ime"
        AccessibilityWindowInfo.TYPE_SYSTEM -> "system"
        AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY -> "a11yOverlay"
        AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER -> "splitDivider"
        else -> "other"
    }

    private fun sendEvent(kind: String, pkg: String?, cls: String?) {
        if (!started) return
        val conn = connection ?: return
        val o = JSONObject()
        o.put("type", "event")
        o.put("kind", kind)
        pkg?.let { o.put("pkg", it) }
        cls?.let { o.put("cls", it) }
        conn.send(o.toString())
    }

    private fun screenSize(): Pair<Int, Int> {
        val dm = resources.displayMetrics
        return dm.widthPixels to dm.heightPixels
    }

    /** Screen geometry, sent with hello and with every tree so a controller can
     *  turn normalized (0..1) coordinates into pixels for THIS device and
     *  orientation instead of hardcoding someone else's screen. */
    private fun screenJson(): JSONObject {
        val (w, h) = screenSize()
        val landscape = resources.configuration.orientation ==
            android.content.res.Configuration.ORIENTATION_LANDSCAPE
        return JSONObject()
            .put("w", w)
            .put("h", h)
            .put("orientation", if (landscape) "landscape" else "portrait")
            .put("density", resources.displayMetrics.density)
    }

    /** Rotation (or a font/density change) invalidates every pixel bound we've
     *  published, and the screen size in `hello` — resend both. */
    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        if (!started) return
        log("configuration changed — re-dumping")
        sendHello()
        pushTree(force = true)
    }

    private fun sendHello() {
        connection?.send(helloJson().toString())
    }

    /** Battery level (%) + charging state, pushed on connect and every 60s. */
    private fun batteryInfo(): Pair<Int?, Boolean> {
        val bm = getSystemService(BATTERY_SERVICE) as? BatteryManager
        val level = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)?.takeIf { it in 0..100 }
        val sticky = registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val isCharging = sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ==
            BatteryManager.BATTERY_STATUS_CHARGING ||
            sticky?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) == BatteryManager.BATTERY_STATUS_FULL
        return level to isCharging
    }

    private fun sendStatusNow() {
        if (!started) return
        val (level, isCharging) = batteryInfo()
        battery = level
        charging = isCharging
        connection?.send(
            JSONObject()
                .put("type", "status")
                .put("battery", level ?: JSONObject.NULL)
                .put("charging", isCharging)
                .toString(),
        )
    }

    private val statusTick = object : Runnable {
        override fun run() {
            if (!started) return
            sendStatusNow()
            mainHandler.postDelayed(this, 60_000)
        }
    }

    private fun helloJson(): JSONObject {
        return JSONObject()
            .put("type", "hello")
            .put("deviceId", Config.deviceId)
            .put("name", Config.deviceName)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("caps", capsJson())
            .put("screen", screenJson())
    }

    /** What this device/OS combination can actually do, so a controller doesn't
     *  have to discover it by failing. Screenshots and IME-enter need API 30. */
    private fun capsJson(): JSONObject =
        JSONObject()
            .put("screenshot", Build.VERSION.SDK_INT >= 30)
            .put("imeEnter", Build.VERSION.SDK_INT >= 30)
            .put("dpadKeys", Build.VERSION.SDK_INT >= 33)
            .put("lockScreen", Build.VERSION.SDK_INT >= 28)
            .put("multiWindow", true)
            .put("maxNodes", TreeDumper.MAX_NODES)
            .put("sdk", Build.VERSION.SDK_INT)

    // ------------------------------------------------------------------ command execution

    /** On-device watchdog per command. Transfers move real bytes, scrollTo and
     *  per-character typing are loops with their own pacing, everything else is a
     *  single UI action. */
    private fun watchdogFor(cmd: String, params: JSONObject): Long = when (cmd) {
        "putFile", "getFile" -> 300_000
        "screenshot" -> 60_000
        "scrollTo" -> 8_000 + 1_500L * params.optInt("maxScrolls", 8)
        "setText" -> {
            val perChar = params.optBoolean("perChar", false)
            if (perChar) {
                12_000 + params.optString("text").length * (params.optInt("charDelayMs", 30) + 25L)
            } else {
                12_000
            }
        }
        else -> 12_000
    }

    private data class Job(
        val cmd: String,
        val params: JSONObject,
        val cmdId: String,
        val timeoutMs: Long,
    )

    private inner class CommandExecutor {
        private val queue = LinkedBlockingQueue<Job>()
        private var busy = false

        fun enqueue(cmd: String, params: JSONObject, cmdId: String, timeoutMs: Long = 12_000) {
            val job = Job(cmd, params, cmdId, timeoutMs)
            // Read-only commands don't touch the UI, so making them wait behind an
            // in-flight gesture only adds latency: a screenshot or a re-dump can run
            // concurrently with a swipe.
            if (cmd in READ_ONLY_CMDS) {
                mainHandler.post { runUnqueued(job) }
                return
            }
            queue.put(job)
            mainHandler.post { pump() }
        }

        fun clear() {
            queue.clear()
            busy = false
        }

        /** Run a read-only job outside the serial queue, still watchdogged so a
         *  wedged screenshot can't leave the caller waiting on nothing. */
        private fun runUnqueued(job: Job) {
            var finished = false
            val watchdog = Runnable {
                if (!finished) {
                    finished = true
                    connection?.sendResult(job.cmdId, false, error = "command timed out on device (${job.cmd})")
                }
            }
            mainHandler.postDelayed(watchdog, job.timeoutMs)
            execute(job.cmd, job.params, job.cmdId) {
                if (!finished) {
                    finished = true
                    mainHandler.removeCallbacks(watchdog)
                }
            }
        }

        private fun pump() {
            if (busy) return
            val job = queue.poll() ?: return
            busy = true
            val watchdog = Runnable {
                if (busy) {
                    busy = false
                    connection?.sendResult(job.cmdId, false, error = "command timed out on device (${job.cmd})")
                    mainHandler.post { pump() }
                }
            }
            mainHandler.postDelayed(watchdog, job.timeoutMs)
            execute(job.cmd, job.params, job.cmdId) {
                mainHandler.removeCallbacks(watchdog)
                busy = false
                mainHandler.post { pump() }
            }
        }

        private fun execute(cmd: String, params: JSONObject, cmdId: String, done: () -> Unit) {
            val conn = connection
            if (conn == null) return done()
            Log.i(TAG, "executing $cmd ($cmdId)")
            try {
                when (cmd) {
                "launch" -> {
                    val pkg = params.optString("package")
                    lastLaunchError = null
                    val ok = launchApp(pkg)
                    conn.sendResult(
                        cmdId,
                        ok,
                        if (ok) JSONObject().put("launched", pkg) else null,
                        if (ok) null else "launch failed: $pkg${lastLaunchError?.let { ": $it" } ?: ""}",
                    )
                    done()
                }
                "tap" -> tap(params, cmdId, done)
                "setText" -> setText(params, cmdId, done)
                "swipe" -> swipe(params, cmdId, done)
                "scroll" -> scroll(params, cmdId, done)
                "scrollTo" -> scrollTo(params, cmdId, done)
                "keyevent" -> keyevent(params, cmdId).let { done() }
                "screenshot" -> screenshot(params, cmdId, done)
                "getFile" -> getFile(params, cmdId, done)
                "refresh" -> {
                    pushTree(force = true)
                    conn.sendResult(cmdId, true, JSONObject().put("refreshed", true))
                    done()
                }
                "panic" -> {
                    performGlobalAction(GLOBAL_ACTION_HOME)
                    conn.sendResult(cmdId, true, JSONObject().put("panic", true))
                    done()
                }
                "putFile" -> putFile(params, cmdId, done)
                "shareFile" -> shareFile(params, cmdId, done)
                else -> {
                    conn.sendResult(cmdId, false, error = "unknown command: $cmd")
                    done()
                }
                }
            } catch (e: Throwable) {
                Log.w(TAG, "command $cmd failed", e)
                conn.sendResult(cmdId, false, error = "exception: ${e::class.simpleName}: ${e.message}")
                done()
            }
        }
    }

    // ------------------------------------------------------------------ actions

    private fun launchApp(pkg: String): Boolean {
        return try {
            // getLaunchIntentForPackage resolves the launcher component itself and
            // sets it explicitly. Starting BY COMPONENT bypasses the
            // FLAG_ACTIVITY_REQUIRE_NON_BROWSER resolution failure that hits apps
            // whose MainActivity also handles browser links (X/Twitter does).
            val intent = packageManager.getLaunchIntentForPackage(pkg)
            if (intent == null) {
                Log.w(TAG, "launch: no launch intent for $pkg")
                return false
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(intent)
            true
        } catch (e: Exception) {
            Log.w(TAG, "launch failed", e)
            lastLaunchError = e.message
            false
        }
    }

    private fun tap(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val find = params.optJSONObject("find")
        if (find != null) {
            val target = findLiveNode(find)
            if (target == null) {
                conn.sendResult(cmdId, false, error = "no node matched find-spec")
                return done()
            }
            val bounds = Rect().also { target.getBoundsInScreen(it) }
            val tapped = JSONObject()
                .put("text", target.text?.toString() ?: JSONObject.NULL)
                .put("resourceId", target.viewIdResourceName ?: JSONObject.NULL)
            val ok = target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            if (ok) {
                target.recycle()
                conn.sendResult(cmdId, true, JSONObject().put("tapped", tapped))
                return done()
            }
            // ACTION_CLICK failed — common on Compose, where the matched node is a
            // text child inside a clickable container. Fall back to a gesture tap
            // at the node's center; the hit lands on whatever is interactive there.
            target.recycle()
            dispatchTap(bounds.exactCenterX(), bounds.exactCenterY()) {
                conn.sendResult(
                    cmdId,
                    true,
                    JSONObject().put("tapped", tapped).put("method", "gesture"),
                )
                done()
            }
            return
        }
        val (w, h) = screenSize()
        val x = coord(params, "x", w)
        val y = coord(params, "y", h)
        if (x == null || y == null) {
            conn.sendResult(cmdId, false, error = "tap needs x+y (px), xn+yn (0..1) or a find-spec")
            return done()
        }
        dispatchTap(x, y) {
            conn.sendResult(cmdId, true, JSONObject().put("tapped", "coords(${x.toInt()},${y.toInt()})"))
            done()
        }
    }

    /** A coordinate in pixels (`x`) or normalized to the current screen (`xn`,
     *  0..1). Normalized coords are what makes a coordinate-based script portable
     *  across devices and rotations instead of pinned to one 1080x2424 phone. */
    private fun coord(params: JSONObject, key: String, size: Int): Float? {
        if (params.has(key)) {
            val v = params.optDouble(key, -1.0)
            if (v >= 0) return v.toFloat()
        }
        if (params.has("${key}n")) {
            val v = params.optDouble("${key}n", -1.0)
            if (v in 0.0..1.0) return (v * size).toFloat()
        }
        return null
    }

    /**
     * Put text into a field.
     *
     * `mode`: `replace` (default), `append` (keep what's there), `clear` (ignore
     * `text`). `perChar` grows the field one character at a time instead of setting
     * the final value in one shot: apps that only react to incremental edits —
     * search-as-you-type, @mention autocomplete — see a TextWatcher callback per
     * step this way. It is still not IME input (no key events, so an app listening
     * for keystrokes specifically won't be fooled), but it is what a11y can offer.
     * `submit` fires the field's IME action (the keyboard's Search/Send/Go) after.
     */
    private fun setText(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val mode = params.optString("mode").ifBlank { "replace" }
        val raw = params.optString("text")
        val target = params.optJSONObject("find")?.let { findLiveNode(it) } ?: findFocusedNode()
        if (target == null) {
            conn.sendResult(cmdId, false, error = "no field to type into (find-spec or focused field)")
            return done()
        }
        // Focus first: some fields reject ACTION_SET_TEXT while unfocused, and the
        // IME action below needs the field focused to have any meaning.
        if (!target.isFocused) target.performAction(AccessibilityNodeInfo.ACTION_FOCUS)

        val existing = target.text?.toString() ?: ""
        val finalText = when (mode) {
            "clear" -> ""
            "append" -> existing + raw
            else -> raw
        }
        val perChar = params.optBoolean("perChar", false) && finalText.isNotEmpty() && mode != "clear"
        val submit = params.optBoolean("submit", false)
        val charDelay = params.optInt("charDelayMs", 30).coerceIn(0, 250).toLong()
        val prefix = if (mode == "append") existing else ""

        fun finish(ok: Boolean, steps: Int) {
            val submitted = if (ok && submit) imeEnter(target) else false
            // The node caches its text from when we fetched it — without refresh()
            // this reports the value from before the edit.
            target.refresh()
            val len = target.text?.toString()?.length ?: -1
            target.recycle()
            conn.sendResult(
                cmdId,
                ok,
                if (ok) {
                    JSONObject().put("set", true).put("mode", mode).put("steps", steps)
                        .put("length", len).put("submitted", submitted)
                } else {
                    null
                },
                if (ok) null else "ACTION_SET_TEXT failed (field may be read-only or a password)",
            )
            done()
        }

        if (!perChar) {
            val ok = applyText(target, finalText)
            return finish(ok, 1)
        }
        // Grow the value one char at a time on the main looper, pacing with
        // charDelayMs so the app's own debounce/autocomplete can keep up.
        val body = finalText.substring(prefix.length)
        var i = 0
        val step = object : Runnable {
            override fun run() {
                if (!started) return finish(false, i)
                i += 1
                val ok = applyText(target, prefix + body.substring(0, i))
                if (!ok) return finish(false, i)
                if (i >= body.length) return finish(true, i)
                mainHandler.postDelayed(this, charDelay)
            }
        }
        mainHandler.post(step)
    }

    /** ACTION_SET_TEXT + move the cursor to the end, so a following append or a
     *  user-visible caret lands where you'd expect. */
    private fun applyText(node: AccessibilityNodeInfo, value: String): Boolean {
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false
        val sel = Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, value.length)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, value.length)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
        return true
    }

    /** The keyboard's action key (Search / Send / Go) for a field. API 30+; older
     *  devices fall back to clicking the field, which some apps treat as submit. */
    private fun imeEnter(node: AccessibilityNodeInfo): Boolean =
        if (Build.VERSION.SDK_INT >= 30) {
            node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
        } else {
            node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }

    private fun swipe(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val (w, h) = screenSize()
        val x1 = coord(params, "x1", w)
        val y1 = coord(params, "y1", h)
        val x2 = coord(params, "x2", w)
        val y2 = coord(params, "y2", h)
        if (x1 == null || y1 == null || x2 == null || y2 == null) {
            conn.sendResult(cmdId, false, error = "swipe needs x1,y1,x2,y2 (px) or x1n,y1n,x2n,y2n (0..1)")
            return done()
        }
        val duration = params.optInt("duration", 400)
        dispatchSwipe(x1, y1, x2, y2, duration.toLong()) {
            conn.sendResult(cmdId, true, JSONObject().put("swiped", true))
            done()
        }
    }

    private fun scroll(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val direction = params.optString("direction", "down")
        if (direction !in DIRECTIONS) {
            conn.sendResult(cmdId, false, error = "bad direction: $direction")
            return done()
        }
        val distance = params.optInt("distance", 600)
        // Ask the scrollable container to scroll itself first: one binder call, it
        // moves by its own page size, and it can't be swallowed by a child view
        // that happens to sit under the gesture path. Gesture is the fallback.
        if (params.optBoolean("gesture", false) || !scrollByAction(direction)) {
            doScrollGesture(direction, distance) {
                conn.sendResult(cmdId, true, JSONObject().put("scrolled", direction).put("method", "gesture"))
                done()
            }
            return
        }
        conn.sendResult(cmdId, true, JSONObject().put("scrolled", direction).put("method", "action"))
        done()
    }

    /**
     * Scroll until a find-spec is on screen (or the attempt budget runs out).
     *
     * The tree only ever contains what is rendered, so "not found" from one dump
     * says nothing about a long list. Doing the scroll-and-recheck loop here means
     * one command instead of a controller round-trip per swipe — each of which cost
     * a dump, a WS hop and an LLM turn.
     */
    private fun scrollTo(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val find = params.optJSONObject("find")
        if (find == null) {
            conn.sendResult(cmdId, false, error = "scrollTo needs a find-spec")
            return done()
        }
        val direction = params.optString("direction").ifBlank { "down" }
        if (direction !in DIRECTIONS) {
            conn.sendResult(cmdId, false, error = "bad direction: $direction")
            return done()
        }
        val maxScrolls = params.optInt("maxScrolls", 8).coerceIn(1, 30)
        val distance = params.optInt("distance", 800)
        val settleMs = params.optInt("settleMs", 450).coerceIn(50, 2000).toLong()

        fun report(found: Boolean, scrolls: Int, node: AccessibilityNodeInfo?) {
            val result = JSONObject().put("found", found).put("scrolls", scrolls)
            if (node != null) {
                val b = Rect().also { node.getBoundsInScreen(it) }
                result.put("text", node.text?.toString() ?: JSONObject.NULL)
                result.put("bounds", org.json.JSONArray().put(b.left).put(b.top).put(b.right).put(b.bottom))
                node.recycle()
            }
            // The screen moved: make sure the controller's next read is current.
            if (scrolls > 0) pushTree(force = true)
            conn.sendResult(cmdId, found, result, if (found) null else "not found after $scrolls scroll(s)")
            done()
        }

        findLiveNode(find)?.let { return report(true, 0, it) }
        var scrolls = 0
        val step = object : Runnable {
            override fun run() {
                if (!started) return report(false, scrolls, null)
                if (scrolls >= maxScrolls) return report(false, scrolls, null)
                scrolls += 1
                val afterScroll = Runnable {
                    val hit = findLiveNode(find)
                    if (hit != null) report(true, scrolls, hit) else mainHandler.post(this)
                }
                if (scrollByAction(direction)) {
                    mainHandler.postDelayed(afterScroll, settleMs)
                } else {
                    doScrollGesture(direction, distance) {
                        mainHandler.postDelayed(afterScroll, settleMs)
                    }
                }
            }
        }
        mainHandler.post(step)
    }

    /** Let the deepest scrollable container scroll itself. Returns false when there
     *  is nothing scrollable (or it reports it can't move further). */
    private fun scrollByAction(direction: String): Boolean {
        val action = when (direction) {
            "down", "right" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            else -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
        }
        val node = findLive { it.isScrollable } ?: return false
        val ok = node.performAction(action)
        node.recycle()
        return ok
    }

    private fun doScrollGesture(direction: String, distance: Int, onDone: () -> Unit) {
        val (w, h) = screenSize()
        val cx = w / 2f
        val cy = h / 2f
        val half = (distance / 2f).coerceAtMost(minOf(w, h) * 0.4f)
        val (x1, y1, x2, y2) = when (direction) {
            "up" -> arrayOf(cx, cy - half, cx, cy + half)
            "down" -> arrayOf(cx, cy + half, cx, cy - half)
            "left" -> arrayOf(cx - half, cy, cx + half, cy)
            else -> arrayOf(cx + half, cy, cx - half, cy)
        }
        dispatchSwipe(x1, y1, x2, y2, 300, onDone)
    }

    /** System keys. An accessibility service can't inject arbitrary key codes — the
     *  set below is what the platform exposes as global actions, plus the focused
     *  field's IME action for `enter`. */
    private fun keyevent(params: JSONObject, cmdId: String) {
        val conn = connection ?: return
        val key = params.optString("key")
        val ok = when (key) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "notifications" -> performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS)
            "quickSettings" -> performGlobalAction(GLOBAL_ACTION_QUICK_SETTINGS)
            "lock" ->
                Build.VERSION.SDK_INT >= 28 && performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
            "dpadUp" -> dpad(GLOBAL_ACTION_DPAD_UP)
            "dpadDown" -> dpad(GLOBAL_ACTION_DPAD_DOWN)
            "dpadLeft" -> dpad(GLOBAL_ACTION_DPAD_LEFT)
            "dpadRight" -> dpad(GLOBAL_ACTION_DPAD_RIGHT)
            "dpadCenter" -> dpad(GLOBAL_ACTION_DPAD_CENTER)
            "enter" -> {
                val f = findFocusedNode()
                val r = f?.let { imeEnter(it) } ?: false
                f?.recycle()
                r
            }
            else -> false
        }
        conn.sendResult(
            cmdId,
            ok,
            if (ok) JSONObject().put("key", key) else null,
            if (ok) null else "keyevent failed or unsupported on this Android version: $key",
        )
    }

    /** D-pad global actions landed in API 33. */
    private fun dpad(action: Int): Boolean =
        Build.VERSION.SDK_INT >= 33 && performGlobalAction(action)

    // ------------------------------------------------------------------ screenshot

    /**
     * Take a real screenshot and stage it on the server (bytes never cross the WS).
     *
     * This is the one thing the accessibility tree fundamentally can't give you:
     * unlabeled images, video frames, charts, "did the right photo attach". Needs
     * API 30+. `FLAG_SECURE` windows come back blank or fail by design — a banking
     * app or DRM video is not screenshottable by anyone.
     *
     * Params: `format` (webp|jpeg|png, default webp — a screen is ~10x smaller as
     * lossy webp than png), `quality` (1..100), `maxDim` (longest edge, default
     * 1280: enough for a vision model to read the screen, a quarter of the bytes).
     */
    private fun screenshot(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        if (Build.VERSION.SDK_INT < 30) {
            conn.sendResult(cmdId, false, error = "screenshot needs Android 11 (API 30); this device is API ${Build.VERSION.SDK_INT}")
            return done()
        }
        val format = params.optString("format").ifBlank { "webp" }.lowercase()
        val quality = params.optInt("quality", 80).coerceIn(1, 100)
        val maxDim = params.optInt("maxDim", 1280).coerceIn(120, 4096)
        val attempt = params.optInt("_attempt", 0)

        takeScreenshot(
            android.view.Display.DEFAULT_DISPLAY,
            { r -> gestureHandler.post(r) }, // compression + upload off the main thread
            object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    var bitmap: android.graphics.Bitmap? = null
                    try {
                        val hw = android.graphics.Bitmap.wrapHardwareBuffer(
                            result.hardwareBuffer,
                            result.colorSpace,
                        )
                        if (hw == null) {
                            conn.sendResult(cmdId, false, error = "screenshot: could not wrap hardware buffer")
                            return
                        }
                        bitmap = scaleTo(hw, maxDim)
                        if (bitmap !== hw) hw.recycle()
                        val (fmt, ext, mime) = when (format) {
                            "png" -> Triple(android.graphics.Bitmap.CompressFormat.PNG, "png", "image/png")
                            "jpeg", "jpg" -> Triple(android.graphics.Bitmap.CompressFormat.JPEG, "jpg", "image/jpeg")
                            else -> Triple(
                                @Suppress("DEPRECATION")
                                if (Build.VERSION.SDK_INT >= 30) {
                                    android.graphics.Bitmap.CompressFormat.WEBP_LOSSY
                                } else {
                                    android.graphics.Bitmap.CompressFormat.WEBP
                                },
                                "webp",
                                "image/webp",
                            )
                        }
                        val name = "screen-${System.currentTimeMillis()}.$ext"
                        val file = File(cacheDir, name)
                        file.outputStream().use { out -> bitmap.compress(fmt, quality, out) }
                        val meta = uploadToServer(file, mime)
                        log("screenshot ${bitmap.width}x${bitmap.height} ${file.length() / 1024} KiB")
                        conn.sendResult(
                            cmdId,
                            true,
                            JSONObject()
                                .put("fileId", meta.getString("fileId"))
                                .put("name", meta.optString("name", name))
                                .put("mime", mime)
                                .put("size", file.length())
                                .put("w", bitmap.width)
                                .put("h", bitmap.height)
                                .put("url", meta.optString("url")),
                        )
                        file.delete()
                    } catch (e: Throwable) {
                        Log.w(TAG, "screenshot failed", e)
                        conn.sendResult(cmdId, false, error = "screenshot failed: ${e.message}")
                    } finally {
                        bitmap?.recycle()
                        result.hardwareBuffer.close()
                        done()
                    }
                }

                override fun onFailure(errorCode: Int) {
                    // The platform rate-limits screenshots (~1 per 333ms). One retry
                    // turns a burst collision into a slightly slower success.
                    if (errorCode == ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT && attempt < 1) {
                        mainHandler.postDelayed({
                            screenshot(JSONObject(params.toString()).put("_attempt", attempt + 1), cmdId, done)
                        }, 400)
                        return
                    }
                    conn.sendResult(cmdId, false, error = "screenshot failed: ${screenshotError(errorCode)}")
                    done()
                }
            },
        )
    }

    private fun screenshotError(code: Int): String = when (code) {
        ERROR_TAKE_SCREENSHOT_INTERNAL_ERROR -> "internal error"
        ERROR_TAKE_SCREENSHOT_NO_ACCESSIBILITY_ACCESS -> "no accessibility access"
        ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT -> "rate limited (retry in ~400ms)"
        ERROR_TAKE_SCREENSHOT_INVALID_DISPLAY -> "invalid display"
        else -> "error code $code (a FLAG_SECURE window cannot be captured)"
    }

    /** Downscale so the longest edge is [maxDim]; returns the input untouched when
     *  it already fits. Cuts upload bytes and the receiver's decode cost. */
    private fun scaleTo(src: android.graphics.Bitmap, maxDim: Int): android.graphics.Bitmap {
        val longest = maxOf(src.width, src.height)
        if (longest <= maxDim) return src
        val f = maxDim.toFloat() / longest
        return android.graphics.Bitmap.createScaledBitmap(
            src,
            (src.width * f).toInt().coerceAtLeast(1),
            (src.height * f).toInt().coerceAtLeast(1),
            true,
        )
    }

    // ------------------------------------------------------------------ file transfer & share

    /** Download a file the server staged for us (via /transfer/<id>) into our
     *  cache. Runs off the main thread — files can be large. */
    private fun putFile(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val fileId = params.optString("fileId")
        if (fileId.isBlank()) {
            conn.sendResult(cmdId, false, error = "putFile needs fileId")
            return done()
        }
        val name = params.optString("name").ifBlank { fileId }
        val mime = params.optString("mime").ifBlank { "application/octet-stream" }
        Thread {
            try {
                val url = Config.httpFromWs(Config.serverUrl) + "/transfer/" + fileId
                val req = Request.Builder().url(url)
                    .apply { if (Config.token.isNotBlank()) header("Authorization", "Bearer ${Config.token}") }
                    .build()
                http.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        conn.sendResult(cmdId, false, error = "download HTTP ${resp.code}")
                    } else {
                        val target = File(cacheDir, name)
                        resp.body?.byteStream()?.use { input ->
                            target.outputStream().use { input.copyTo(it, 64 * 1024) }
                        }
                        log("putFile $name (${target.length() / 1024} KiB)")
                        conn.sendResult(
                            cmdId,
                            true,
                            JSONObject()
                                .put("path", target.absolutePath)
                                .put("size", target.length()),
                        )
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "putFile failed", e)
                conn.sendResult(cmdId, false, error = "putFile failed: ${e.message}")
            } finally {
                done()
            }
        }.start()
    }

    /**
     * Upload a file from the phone's cache to the server's transfer staging area,
     * so a controller can fetch it over HTTP. Streams from disk — a video must not
     * be buffered in the app's heap. Returns the server's transfer metadata.
     * Blocking; call from a background thread.
     */
    private fun uploadToServer(file: File, mime: String): JSONObject {
        val url = Config.httpFromWs(Config.serverUrl) + "/api/v1/transfer"
        val body = object : okhttp3.RequestBody() {
            override fun contentType() = mime.toMediaTypeOrNull()
            override fun contentLength() = file.length()
            override fun writeTo(sink: okio.BufferedSink) {
                file.source().use { sink.writeAll(it) }
            }
        }
        val req = Request.Builder()
            .url(url)
            .post(body)
            .header("x-file-name", java.net.URLEncoder.encode(file.name, "UTF-8"))
            .header("x-file-mime", mime)
            .apply { if (Config.token.isNotBlank()) header("Authorization", "Bearer ${Config.token}") }
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) throw java.io.IOException("upload HTTP ${resp.code}: ${text.take(120)}")
            return JSONObject(text)
        }
    }

    /** Pull a file off the phone: upload it to the server's staging area and hand
     *  back a fileId the controller can download. The counterpart to putFile —
     *  without it, anything the phone produces (a saved image, an export) is
     *  stranded on the device. */
    private fun getFile(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val name = params.optString("name")
        val path = params.optString("path")
        val file = when {
            path.isNotBlank() -> File(path)
            name.isNotBlank() -> File(cacheDir, name)
            else -> null
        }
        if (file == null) {
            conn.sendResult(cmdId, false, error = "getFile needs name (in the bridge cache) or path")
            return done()
        }
        // Only our own storage: the bridge should not be a general file exfiltration
        // tool for the whole device.
        val allowed = file.canonicalPath.startsWith(cacheDir.canonicalPath) ||
            file.canonicalPath.startsWith(filesDir.canonicalPath) ||
            (externalCacheDir?.let { file.canonicalPath.startsWith(it.canonicalPath) } ?: false)
        if (!allowed) {
            conn.sendResult(cmdId, false, error = "getFile is limited to the bridge's own cache/files dirs")
            return done()
        }
        if (!file.exists()) {
            conn.sendResult(cmdId, false, error = "no such file on device: ${file.name}")
            return done()
        }
        val mime = params.optString("mime").ifBlank { guessMime(file.name) }
        Thread {
            try {
                val meta = uploadToServer(file, mime)
                log("getFile ${file.name} (${file.length() / 1024} KiB)")
                conn.sendResult(
                    cmdId,
                    true,
                    JSONObject()
                        .put("fileId", meta.getString("fileId"))
                        .put("name", meta.optString("name", file.name))
                        .put("mime", mime)
                        .put("size", file.length())
                        .put("url", meta.optString("url")),
                )
            } catch (e: Exception) {
                Log.w(TAG, "getFile failed", e)
                conn.sendResult(cmdId, false, error = "getFile failed: ${e.message}")
            } finally {
                done()
            }
        }.start()
    }

    private fun guessMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "mp4" -> "video/mp4"
        "mov" -> "video/quicktime"
        "webm" -> "video/webm"
        "txt", "log" -> "text/plain"
        "json" -> "application/json"
        else -> "application/octet-stream"
    }

    /** Hand a file on the phone to another app via ACTION_SEND. With
     *  targetPackage=com.twitter.android this opens the X composer with the
     *  media attached; the a11y tools then type text and tap Post. */
    private fun shareFile(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        try {
            val fileId = params.optString("fileId")
            val name = params.optString("name").ifBlank { fileId }
            val mime = params.optString("mime").ifBlank { "application/octet-stream" }
            val targetPackage = params.optString("targetPackage").ifBlank { null }
            val file = File(cacheDir, name)
            if (!file.exists()) {
                conn.sendResult(cmdId, false, error = "file not on device (run putFile first)")
                return done()
            }
            val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = mime
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            if (targetPackage != null) intent.setPackage(targetPackage)
            startActivity(if (targetPackage == null) Intent.createChooser(intent, "Share via social-puppet") else intent)
            log("share $name ($mime)${targetPackage?.let { " → $it" } ?: ""}")
            conn.sendResult(
                cmdId,
                true,
                JSONObject().put("shared", name).put("mime", mime).put("targetPackage", targetPackage ?: "chooser"),
            )
        } catch (e: Exception) {
            Log.w(TAG, "shareFile failed", e)
            conn.sendResult(cmdId, false, error = "shareFile failed: ${e.message}")
        } finally {
            done()
        }
    }

    // ------------------------------------------------------------------ gestures & find

    private fun dispatchTap(x: Float, y: Float, onDone: () -> Unit) {
        val path = Path().apply { moveTo(x, y) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 80))
            .build()
        val started = dispatchGesture(
            gesture,
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) = onDone()
                override fun onCancelled(gestureDescription: GestureDescription?) = onDone()
            },
            // callbacks on a background looper: the executor runs commands on the
            // main thread and only releases when the gesture finishes, so a
            // main-thread callback would deadlock (it could never run).
            gestureHandler,
        )
        if (!started) {
            Log.w(TAG, "dispatchGesture returned false (tap $x,$y)")
            onDone()
        }
    }

    private fun dispatchSwipe(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long, onDone: () -> Unit) {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        val started = dispatchGesture(
            gesture,
            object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) = onDone()
                override fun onCancelled(gestureDescription: GestureDescription?) = onDone()
            },
            gestureHandler,
        )
        if (!started) {
            Log.w(TAG, "dispatchGesture returned false (swipe)")
            onDone()
        }
    }

    /**
     * Find a live node matching the find-spec (text / resourceId / contentDesc).
     *
     * The fast paths matter: `findAccessibilityNodeInfosByViewId` and
     * `...ByText` run the search inside the target app's process and return in a
     * single binder round-trip, where the manual DFS below costs one round-trip per
     * node visited — hundreds to thousands per tap. We only walk by hand when the
     * indexed queries can't express the spec or come back empty.
     */
    private fun findLiveNode(find: JSONObject): AccessibilityNodeInfo? {
        val text = find.optString("text")
        val contains = find.optBoolean("contains", false)
        val rid = find.optString("resourceId")
        val desc = find.optString("contentDesc")
        if (text.isEmpty() && rid.isEmpty() && desc.isEmpty()) return null
        val matches = matcher(text, contains, rid, desc)

        for (root in searchRoots()) {
            // resource-id: exact-id lookup is indexed by the framework.
            if (rid.isNotEmpty() && !contains) {
                root.findAccessibilityNodeInfosByViewId(rid)?.let { hits ->
                    hits.firstOrNull(matches)?.let { hit ->
                        for (h in hits) if (h !== hit) h.recycle()
                        return hit
                    }
                    for (h in hits) h.recycle()
                }
            }
            // text / contentDesc: byText is a substring, case-insensitive search over
            // both text AND content description, done app-side. Exact matches are
            // then filtered locally — a superset search plus a cheap local filter.
            val needle = if (text.isNotEmpty()) text else desc
            if (needle.isNotEmpty()) {
                root.findAccessibilityNodeInfosByText(needle)?.let { hits ->
                    hits.firstOrNull(matches)?.let { hit ->
                        for (h in hits) if (h !== hit) h.recycle()
                        return hit
                    }
                    for (h in hits) h.recycle()
                }
            }
            // Nothing indexed could serve the spec (contains-on-resourceId, or the
            // app doesn't expose it to those queries) — walk it.
            searchLive(root, pred = matches)?.let { return it }
        }
        return null
    }

    /** Case-insensitive predicate for a find-spec. */
    private fun matcher(
        text: String,
        contains: Boolean,
        rid: String,
        desc: String,
    ): (AccessibilityNodeInfo) -> Boolean {
        val t = text.lowercase()
        val r = rid.lowercase()
        val d = desc.lowercase()
        return { n ->
            var m = true
            if (t.isNotEmpty()) {
                val nt = n.text?.toString()?.lowercase() ?: ""
                m = if (contains) nt.contains(t) else nt == t
            }
            if (m && r.isNotEmpty()) {
                val nr = n.viewIdResourceName?.lowercase() ?: ""
                m = if (contains) nr.contains(r) else nr == r
            }
            if (m && d.isNotEmpty()) {
                val nd = n.contentDescription?.toString()?.lowercase() ?: ""
                m = if (contains) nd.contains(d) else nd == d
            }
            m
        }
    }

    /** Roots to search, active window first, then the other interactive windows —
     *  so taps and typing reach an IME, a dialog or the notification shade, which
     *  `rootInActiveWindow` alone can't see. */
    private fun searchRoots(): List<AccessibilityNodeInfo> {
        val out = ArrayList<AccessibilityNodeInfo>(4)
        val active = rootInActiveWindow
        if (active != null) out.add(active)
        for (w in safeWindows()) {
            if (active != null && w.id == active.windowId) continue
            w.root?.let { out.add(it) }
        }
        return out
    }

    /** First node across all windows matching [pred]. */
    private fun findLive(pred: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        for (root in searchRoots()) searchLive(root, pred = pred)?.let { return it }
        return null
    }

    private fun findFocusedNode(): AccessibilityNodeInfo? =
        findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: findLive { it.isFocused }

    /** DFS over live nodes; recycles everything except the returned node. Must be
     *  called on the main thread. Bounded: some apps expose cyclic accessibility
     *  trees — depth and node budgets make a cycle a miss, not a crash. */
    private fun searchLive(
        node: AccessibilityNodeInfo,
        depth: Int = 0,
        budget: IntArray = intArrayOf(3000),
        pred: (AccessibilityNodeInfo) -> Boolean,
    ): AccessibilityNodeInfo? {
        if (depth > 60 || budget[0]-- <= 0) return null
        if (pred(node)) return node
        val children = ArrayList<AccessibilityNodeInfo>()
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { children.add(it) }
        }
        for (c in children) {
            val hit = searchLive(c, depth + 1, budget, pred)
            c.recycle()
            if (hit != null) return hit
        }
        return null
    }
}
