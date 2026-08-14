package dev.socialpuppet.bridge

import android.graphics.Rect
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject

/** Snapshot of one accessibility node, safe to keep after the live node is recycled. */
data class Node(
    val id: Int,
    val text: String?,
    val contentDesc: String?,
    val resourceId: String?,
    val className: String?,
    val clickable: Boolean,
    val visible: Boolean,
    val bounds: IntArray, // left, top, right, bottom
    val children: List<Node> = emptyList(),
)

/** Walks the live accessibility tree into [Node]s and serializes them per PROTOCOL.md. */
object TreeDumper {
    const val MAX_NODES = 800

    fun dump(root: AccessibilityNodeInfo?): List<Node> {
        if (root == null) return emptyList()
        val counter = intArrayOf(0)
        val roots = ArrayList<Node>()
        val children = ArrayList<AccessibilityNodeInfo>()
        for (i in 0 until root.childCount) {
            root.getChild(i)?.let { children.add(it) }
        }
        for (c in children) {
            walk(c, counter, roots)
            c.recycle()
        }
        return roots
    }

    private fun walk(node: AccessibilityNodeInfo, counter: IntArray, siblings: MutableList<Node>) {
        if (counter[0] >= MAX_NODES) return
        val id = counter[0]++

        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val visible = node.isVisibleToUser
        val hasText = !node.text.isNullOrBlank()
        val hasDesc = !node.contentDescription.isNullOrBlank()
        val hasSize = bounds.width() > 0 && bounds.height() > 0
        val keepSelf = hasText || hasDesc || node.isClickable || hasSize

        val liveChildren = ArrayList<AccessibilityNodeInfo>()
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { liveChildren.add(it) }
        }
        val childNodes = ArrayList<Node>()
        for (c in liveChildren) {
            walk(c, counter, childNodes)
            c.recycle()
        }
        if (!keepSelf && childNodes.isEmpty()) return

        siblings.add(
            Node(
                id = id,
                text = node.text?.toString(),
                contentDesc = node.contentDescription?.toString(),
                resourceId = node.viewIdResourceName,
                className = node.className?.toString(),
                clickable = node.isClickable,
                visible = visible,
                bounds = intArrayOf(bounds.left, bounds.top, bounds.right, bounds.bottom),
                children = childNodes,
            ),
        )
    }

    /** Recursive DFS over [nodes]; returns the first node matching the find-spec. */
    fun find(
        nodes: List<Node>,
        text: String,
        contains: Boolean,
        resourceId: String,
        contentDesc: String,
    ): Node? {
        val wantText = text.isNotEmpty()
        val wantRid = resourceId.isNotEmpty()
        val wantDesc = contentDesc.isNotEmpty()
        if (!wantText && !wantRid && !wantDesc) return null
        val t = text.lowercase()
        val r = resourceId.lowercase()
        val d = contentDesc.lowercase()

        fun match(n: Node): Boolean {
            if (wantText) {
                val nt = n.text?.lowercase() ?: ""
                if (if (contains) !nt.contains(t) else nt != t) return false
            }
            if (wantRid) {
                val nr = n.resourceId?.lowercase() ?: ""
                if (if (contains) !nr.contains(r) else nr != r) return false
            }
            if (wantDesc) {
                val nd = n.contentDesc?.lowercase() ?: ""
                if (if (contains) !nd.contains(d) else nd != d) return false
            }
            return true
        }

        fun walkList(list: List<Node>): Node? {
            for (n in list) {
                if (match(n)) return n
                walkList(n.children)?.let { return it }
            }
            return null
        }
        return walkList(nodes)
    }

    fun toJson(nodes: List<Node>): JSONObject {
        val arr = JSONArray()
        for (n in nodes) arr.put(nodeToJson(n))
        return JSONObject().put("nodes", arr)
    }

    private fun nodeToJson(n: Node): JSONObject {
        val o = JSONObject()
        o.put("id", n.id)
        n.text?.let { o.put("text", it) }
        n.contentDesc?.let { o.put("contentDesc", it) }
        n.resourceId?.let { o.put("resourceId", it) }
        n.className?.let { o.put("className", it) }
        o.put("clickable", n.clickable)
        o.put("visible", n.visible)
        o.put(
            "bounds",
            JSONArray().apply {
                put(n.bounds[0])
                put(n.bounds[1])
                put(n.bounds[2])
                put(n.bounds[3])
            },
        )
        if (n.children.isNotEmpty()) {
            val ch = JSONArray()
            for (c in n.children) ch.put(nodeToJson(c))
            o.put("children", ch)
        }
        return o
    }
}
