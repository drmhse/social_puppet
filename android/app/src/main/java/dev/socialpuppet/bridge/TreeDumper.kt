package dev.socialpuppet.bridge

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

/** Which window a root node came from, so the controller can tell an app screen
 *  from an IME, a system dialog, or the notification shade. */
data class WindowTag(
    val id: Int,
    val type: String,
    val active: Boolean,
    val pkg: String?,
)

/** Snapshot of one accessibility node, safe to keep after the live node is recycled. */
class Node(
    val id: Int,
    val text: String?,
    val contentDesc: String?,
    val resourceId: String?,
    val className: String?,
    val clickable: Boolean,
    val visible: Boolean,
    val bounds: IntArray, // left, top, right, bottom
    val children: List<Node>,
    /** Set on window roots only. */
    var window: WindowTag? = null,
)

/**
 * Node-id allocator, node budget and rolling content hash for one dump, shared
 * across every window so ids stay unique and the total stays bounded.
 *
 * The hash is the reason this class exists: it lets [BridgeService] decide whether
 * a screen actually changed *before* serializing anything. Walking the live tree
 * costs one binder round-trip per node and can't be avoided, but turning 1500
 * nodes into JSON only to discover the result is byte-identical to the last push
 * is pure waste — and content-changed events arrive in bursts.
 *
 * [truncated] records whether the budget cut the walk short: the controller needs
 * to know that "not on screen" might mean "past the budget".
 */
class DumpBudget(private val maxNodes: Int = TreeDumper.MAX_NODES) {
    var nextId = 0
        private set
    var truncated = false
        private set

    // FNV-1a, 64-bit. Cheap, allocation-free, and good enough that a collision
    // (which would cost us one skipped push until the next change) is theoretical.
    private var h = -3750763034362895579L // FNV offset basis

    fun take(): Int? {
        if (nextId >= maxNodes) {
            truncated = true
            return null
        }
        return nextId++
    }

    fun mix(v: Int) {
        h = (h xor v.toLong()) * 1099511628211L
    }

    fun mix(s: String?) {
        // String.hashCode is cached by the JVM — no allocation, no char walk on
        // repeat pushes of the same labels.
        mix(s?.hashCode() ?: 0)
    }

    fun mix(b: Boolean) = mix(if (b) 1 else 2)

    val hash: Long get() = h
    val count: Int get() = nextId
}

/** Walks the live accessibility tree into [Node]s and serializes them per PROTOCOL.md. */
object TreeDumper {
    /** Deep enough for a dense feed (~500 nodes/screen) with headroom for an
     *  overlay on top; the whole tree is re-serialized on every change, so this is
     *  also a bandwidth ceiling. */
    const val MAX_NODES = 1500

    /**
     * Dump one window's content. [tag] is attached to the roots it produces, and
     * [screen] prunes subtrees that lie entirely outside it — a list view keeps
     * recycled rows just off both edges, and those cost binder traffic and nodes
     * for content that can't be seen or tapped.
     */
    fun dump(
        root: AccessibilityNodeInfo?,
        budget: DumpBudget,
        tag: WindowTag? = null,
        screen: Rect? = null,
    ): List<Node> {
        if (root == null) return emptyList()
        if (tag != null) {
            budget.mix(tag.id)
            budget.mix(tag.type)
            budget.mix(tag.active)
        }
        val roots = ArrayList<Node>(root.childCount)
        val scratch = Rect()
        for (i in 0 until root.childCount) {
            val c = root.getChild(i) ?: continue
            walk(c, budget, roots, screen, scratch)
            c.recycle()
        }
        if (tag != null) for (r in roots) r.window = tag
        return roots
    }

    private fun walk(
        node: AccessibilityNodeInfo,
        budget: DumpBudget,
        siblings: MutableList<Node>,
        screen: Rect?,
        scratch: Rect,
    ) {
        node.getBoundsInScreen(scratch)
        val l = scratch.left
        val t = scratch.top
        val r = scratch.right
        val b = scratch.bottom
        val hasSize = r > l && b > t
        // Fully offscreen and non-degenerate: nothing here or below is reachable.
        if (hasSize && screen != null && (r <= screen.left || l >= screen.right || b <= screen.top || t >= screen.bottom)) {
            return
        }

        val id = budget.take() ?: return
        val text = node.text?.toString()
        val desc = node.contentDescription?.toString()
        val rid = node.viewIdResourceName
        val cls = node.className?.toString()
        val clickable = node.isClickable
        val visible = node.isVisibleToUser
        val keepSelf = !text.isNullOrBlank() || !desc.isNullOrBlank() || clickable || hasSize

        // Bounds are already copied into locals, so the same scratch Rect can be
        // reused all the way down instead of one per level.
        var childNodes: ArrayList<Node>? = null
        if (node.childCount > 0) {
            childNodes = ArrayList(node.childCount)
            for (i in 0 until node.childCount) {
                val c = node.getChild(i) ?: continue
                walk(c, budget, childNodes, screen, scratch)
                c.recycle()
            }
        }
        if (!keepSelf && childNodes.isNullOrEmpty()) return

        budget.mix(id)
        budget.mix(text)
        budget.mix(desc)
        budget.mix(rid)
        budget.mix(cls)
        budget.mix(clickable)
        budget.mix(visible)
        budget.mix(l)
        budget.mix(t)
        budget.mix(r)
        budget.mix(b)

        siblings.add(
            Node(
                id = id,
                text = text,
                contentDesc = desc,
                resourceId = rid,
                className = cls,
                clickable = clickable,
                visible = visible,
                bounds = intArrayOf(l, t, r, b),
                children = childNodes ?: emptyList(),
            ),
        )
    }

    /**
     * Serialize straight into a [StringBuilder]. The previous version built a
     * parallel tree of JSONObject/JSONArray instances and then stringified it,
     * which for 1500 nodes meant thousands of throwaway HashMaps on the main
     * thread. `JSONObject.quote` still does the escaping, so this is exactly as
     * safe and roughly a third of the allocations.
     */
    fun appendNodes(sb: StringBuilder, nodes: List<Node>) {
        sb.append('[')
        for (i in nodes.indices) {
            if (i > 0) sb.append(',')
            appendNode(sb, nodes[i])
        }
        sb.append(']')
    }

    private fun appendNode(sb: StringBuilder, n: Node) {
        sb.append("{\"id\":").append(n.id)
        field(sb, "text", n.text)
        field(sb, "contentDesc", n.contentDesc)
        field(sb, "resourceId", n.resourceId)
        field(sb, "className", n.className)
        sb.append(",\"clickable\":").append(n.clickable)
        sb.append(",\"visible\":").append(n.visible)
        n.window?.let { w ->
            sb.append(",\"window\":{\"id\":").append(w.id)
            sb.append(",\"type\":").append(JSONObject.quote(w.type))
            sb.append(",\"active\":").append(w.active)
            sb.append(",\"pkg\":")
            if (w.pkg == null) sb.append("null") else sb.append(JSONObject.quote(w.pkg))
            sb.append('}')
        }
        sb.append(",\"bounds\":[").append(n.bounds[0]).append(',').append(n.bounds[1])
            .append(',').append(n.bounds[2]).append(',').append(n.bounds[3]).append(']')
        if (n.children.isNotEmpty()) {
            sb.append(",\"children\":")
            appendNodes(sb, n.children)
        }
        sb.append('}')
    }

    private fun field(sb: StringBuilder, key: String, value: String?) {
        if (value == null) return
        sb.append(",\"").append(key).append("\":").append(JSONObject.quote(value))
    }

    /** Estimated serialized size, used to pre-size the builder. */
    fun estimateChars(nodeCount: Int): Int = 128 + nodeCount * 160
}
