package dev.socialpuppet.bridge

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.Path
import android.graphics.Rect
import android.os.BatteryManager
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue

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
    private var connection: ServerConnection? = null
    private var lastTreeJson: String? = null
    private var dumpScheduled = false
    private val executor = CommandExecutor()
    private var started = false

    companion object {
        private const val TAG = "BridgeService"
        private const val CHANNEL_ID = "bridge"
        private const val NOTIF_ID = 1

        @Volatile
        var status: String = "service not running"

        @Volatile
        var lastLaunchError: String? = null

        @Volatile
        var battery: Int? = null

        @Volatile
        var charging = false

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
        startForegroundWithNotification()
        started = true
        lastTreeJson = null
        connection = ServerConnection(
            onCommand = { cmd, params, cmdId -> executor.enqueue(cmd, params, cmdId) },
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
        status = "service enabled — connecting…"
        log("service enabled, connecting to ${Config.serverUrl}")
        mainHandler.postDelayed(statusTick, 60_000)
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
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_bridge_small)
            .setContentTitle("social-puppet bridge")
            .setContentText("server: ${Config.serverUrl}")
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .build()
        ServiceCompat.startForeground(
            this,
            NOTIF_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )
    }

    // ------------------------------------------------------------------ screen pushing

    private fun scheduleDump(delayMs: Long) {
        if (!started || dumpScheduled) return
        dumpScheduled = true
        mainHandler.postDelayed({
            dumpScheduled = false
            pushTree(force = false)
        }, delayMs)
    }

    /** Dump the current screen and push it. [force] bypasses content dedup (used
     *  for refresh and on connect). */
    private fun pushTree(force: Boolean) {
        if (!started) return
        val conn = connection ?: return
        try {
            val root = rootInActiveWindow ?: return
            val nodes = TreeDumper.dump(root)
            val json = TreeDumper.toJson(nodes)
            json.put("type", "tree")
            json.put("seq", System.currentTimeMillis())
            json.put("pkg", root.packageName?.toString())
            val text = json.toString()
            if (!force && text == lastTreeJson) return
            lastTreeJson = text
            conn.send(text)
        } catch (e: Throwable) {
            Log.w(TAG, "pushTree failed", e)
        }
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
        val (w, h) = screenSize()
        return JSONObject()
            .put("type", "hello")
            .put("deviceId", Config.deviceId)
            .put("name", Config.deviceName)
            .put("appVersion", BuildConfig.VERSION_NAME)
            .put("screen", JSONObject().put("w", w).put("h", h))
    }

    // ------------------------------------------------------------------ command execution

    private inner class CommandExecutor {
        private val queue = LinkedBlockingQueue<Triple<String, JSONObject, String>>()
        private var busy = false

        fun enqueue(cmd: String, params: JSONObject, cmdId: String) {
            queue.put(Triple(cmd, params, cmdId))
            mainHandler.post { pump() }
        }

        fun clear() {
            queue.clear()
            busy = false
        }

        private fun pump() {
            if (busy) return
            val job = queue.poll() ?: return
            busy = true
            val watchdog = Runnable {
                if (busy) {
                    busy = false
                    connection?.sendResult(job.third, false, error = "command timed out on device (no result in 20s)")
                    mainHandler.post { pump() }
                }
            }
            mainHandler.postDelayed(watchdog, 12000)
            execute(job.first, job.second, job.third) {
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
                "setText" -> setText(params, cmdId).let { done() }
                "swipe" -> swipe(params, cmdId, done)
                "scroll" -> scroll(params, cmdId, done)
                "keyevent" -> keyevent(params, cmdId).let { done() }
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
        val x = params.optInt("x", -1)
        val y = params.optInt("y", -1)
        if (x < 0 || y < 0) {
            conn.sendResult(cmdId, false, error = "tap needs x+y or a find-spec")
            return done()
        }
        dispatchTap(x.toFloat(), y.toFloat()) {
            conn.sendResult(cmdId, true, JSONObject().put("tapped", "coords($x,$y)"))
            done()
        }
    }

    private fun setText(params: JSONObject, cmdId: String) {
        val conn = connection ?: return
        val text = params.optString("text")
        var target = params.optJSONObject("find")?.let { findLiveNode(it) }
        if (target == null) target = findFocusedNode()
        if (target == null) {
            conn.sendResult(cmdId, false, error = "no field to type into (find-spec or focused field)")
            return
        }
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        val ok = target.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        conn.sendResult(
            cmdId,
            ok,
            if (ok) JSONObject().put("set", true) else null,
            if (ok) null else "ACTION_SET_TEXT failed",
        )
    }

    private fun swipe(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val x1 = params.optInt("x1")
        val y1 = params.optInt("y1")
        val x2 = params.optInt("x2")
        val y2 = params.optInt("y2")
        val duration = params.optInt("duration", 400)
        dispatchSwipe(x1.toFloat(), y1.toFloat(), x2.toFloat(), y2.toFloat(), duration.toLong()) {
            conn.sendResult(cmdId, true, JSONObject().put("swiped", true))
            done()
        }
    }

    private fun scroll(params: JSONObject, cmdId: String, done: () -> Unit) {
        val conn = connection ?: return done()
        val direction = params.optString("direction", "down")
        val distance = params.optInt("distance", 600)
        val (w, h) = screenSize()
        val cx = w / 2f
        val cy = h / 2f
        val half = distance / 2f
        val (x1, y1, x2, y2) = when (direction) {
            "up" -> arrayOf(cx, cy + half, cx, cy - half)
            "down" -> arrayOf(cx, cy - half, cx, cy + half)
            "left" -> arrayOf(cx + half, cy, cx - half, cy)
            "right" -> arrayOf(cx - half, cy, cx + half, cy)
            else -> return conn.sendResult(cmdId, false, error = "bad direction: $direction").let { done() }
        }
        dispatchSwipe(x1, y1, x2, y2, 300) {
            conn.sendResult(cmdId, true, JSONObject().put("scrolled", direction))
            done()
        }
    }

    private fun keyevent(params: JSONObject, cmdId: String) {
        val conn = connection ?: return
        val key = params.optString("key")
        val ok = when (key) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "enter" -> findFocusedNode()?.performAction(AccessibilityNodeInfo.ACTION_CLICK) ?: false
            else -> false
        }
        conn.sendResult(
            cmdId,
            ok,
            if (ok) JSONObject().put("key", key) else null,
            if (ok) null else "keyevent failed: $key",
        )
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

    /** Find a live node matching the find-spec (text / resourceId / contentDesc). */
    private fun findLiveNode(find: JSONObject): AccessibilityNodeInfo? {
        val text = find.optString("text")
        val contains = find.optBoolean("contains", false)
        val rid = find.optString("resourceId")
        val desc = find.optString("contentDesc")
        if (text.isEmpty() && rid.isEmpty() && desc.isEmpty()) return null
        val root = rootInActiveWindow ?: return null
        return searchLive(root) { n ->
            var m = true
            if (text.isNotEmpty()) {
                val t = n.text?.toString()?.lowercase() ?: ""
                m = m && (if (contains) t.contains(text.lowercase()) else t == text.lowercase())
            }
            if (rid.isNotEmpty()) {
                val r = n.viewIdResourceName?.lowercase() ?: ""
                m = m && (if (contains) r.contains(rid.lowercase()) else r == rid.lowercase())
            }
            if (desc.isNotEmpty()) {
                val d = n.contentDescription?.toString()?.lowercase() ?: ""
                m = m && (if (contains) d.contains(desc.lowercase()) else d == desc.lowercase())
            }
            m
        }
    }

    private fun findFocusedNode(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        return searchLive(root) { it.isFocused }
    }

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
