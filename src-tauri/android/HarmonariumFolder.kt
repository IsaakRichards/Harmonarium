package com.isaakrichards.harmonarium

// "Add a whole folder" on Android.
//
// scripts/android-overlay.mjs copies this file into the generated Android project, registers it on
// the webview as `window.HarmonariumFolder`, and passes MainActivity's activity results to it.
// pick() opens the system's folder picker, which grants access to that one folder only; the books
// in it (subfolders too) are sent back as a `harmonarium:folder` event:
//   { folder, books: [{ ref, name, folder, size }] }   or   { cancelled: true }   or   { error }
// read(ref) then returns one of those books as Base64.

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

class HarmonariumFolder(private val activity: Activity, private val webView: WebView) {
    companion object {
        const val REQUEST = 0x4846 // "HF"
    }

    /** Books found in folders the reader picked; only these may be read. */
    private val found = mutableSetOf<String>()

    @JavascriptInterface
    fun pick() {
        activity.runOnUiThread {
            try {
                @Suppress("DEPRECATION")
                activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQUEST)
            } catch (e: Exception) {
                send(JSONObject().put("error", e.message ?: "no folder picker on this device"))
            }
        }
    }

    /** MainActivity hands over the picker's answer. */
    fun onResult(resultCode: Int, data: Intent?) {
        val tree = data?.data
        if (resultCode != Activity.RESULT_OK || tree == null) {
            send(JSONObject().put("cancelled", true))
            return
        }
        thread {
            try {
                val rootId = DocumentsContract.getTreeDocumentId(tree)
                val books = JSONArray()
                walk(tree, rootId, "", books, 0)
                send(JSONObject().put("folder", nameOf(tree, rootId)).put("books", books))
            } catch (e: Exception) {
                send(JSONObject().put("error", e.message ?: "couldn't look through that folder"))
            }
        }
    }

    private fun nameOf(tree: Uri, docId: String): String = try {
        activity.contentResolver.query(
            DocumentsContract.buildDocumentUriUsingTree(tree, docId),
            arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null,
        )?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: "Folder"
    } catch (e: Exception) { "Folder" }

    private fun walk(tree: Uri, docId: String, rel: String, out: JSONArray, depth: Int) {
        if (depth > 16 || out.length() >= 50000) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
        )
        activity.contentResolver.query(children, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                val mime = c.getString(2) ?: ""
                val size = if (c.isNull(3)) 0L else c.getLong(3)
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    if (!name.startsWith(".")) walk(tree, id, if (rel.isEmpty()) name else "$rel/$name", out, depth + 1)
                } else if (name.endsWith(".epub", true) || name.endsWith(".pdf", true) ||
                    mime == "application/epub+zip" || mime == "application/pdf") {
                    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id).toString()
                    synchronized(found) { found.add(uri) }
                    val shown = if (name.contains('.')) name else name + (if (mime == "application/pdf") ".pdf" else ".epub")
                    out.put(JSONObject().put("ref", uri).put("name", shown).put("folder", rel).put("size", size))
                }
            }
        }
    }

    /** One book from a picked folder, as Base64 ("" if it isn't one of them or can't be read). */
    @JavascriptInterface
    fun read(ref: String): String {
        if (!synchronized(found) { found.contains(ref) }) return ""
        return try {
            activity.contentResolver.openInputStream(Uri.parse(ref))?.use {
                Base64.encodeToString(it.readBytes(), Base64.NO_WRAP)
            } ?: ""
        } catch (e: Exception) { "" }
    }

    private fun send(detail: JSONObject) {
        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('harmonarium:folder', { detail: $detail }))", null,
            )
        }
    }
}
