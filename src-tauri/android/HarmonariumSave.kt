package com.isaakrichards.harmonarium

// Saving a file the app made (a backup) on Android.
//
// scripts/android-overlay.mjs copies this file into the generated Android project, registers it on
// the webview as `window.HarmonariumSave`, and passes MainActivity's activity results to it.
// begin(name, mime) opens the system's "save as" screen; the answer comes back as a
// `harmonarium:save` event: { ready: true, name } or { cancelled: true } or { error }.
// The page then sends the file in pieces with write(base64) and finishes with end(), or abort()
// to throw the half-written file away.
//
// Automatic backups go into Downloads/Harmonarium without asking (Android 10 and later; earlier
// versions use the app's own folder): autoBegin(name) opens one there for write()/end()/abort(),
// autoList() lists the app's automatic backups (JSON) and autoRemove(name) deletes one. Only names
// "Harmonarium-auto-…zip" are accepted.

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream

class HarmonariumSave(private val activity: Activity, private val webView: WebView) {
    companion object {
        const val REQUEST = 0x4853 // "HS"
        private val AUTO_NAME = Regex("^Harmonarium-auto-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\\.zip$")
        private const val AUTO_DIR = "Harmonarium"
    }

    /** How the file being written ends: a "save as" document, a Downloads entry, or a plain file. */
    private var kind = "document"

    private val lock = Any()
    private var out: OutputStream? = null
    private var uri: Uri? = null

    @JavascriptInterface
    fun begin(name: String, mime: String) {
        activity.runOnUiThread {
            try {
                val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType(mime.ifBlank { "application/octet-stream" })
                    .putExtra(Intent.EXTRA_TITLE, name)
                @Suppress("DEPRECATION")
                activity.startActivityForResult(intent, REQUEST)
            } catch (e: Exception) {
                send(JSONObject().put("error", e.message ?: "no way to save files on this device"))
            }
        }
    }

    /** MainActivity hands over the "save as" answer. */
    fun onResult(resultCode: Int, data: Intent?) {
        val target = data?.data
        if (resultCode != Activity.RESULT_OK || target == null) {
            send(JSONObject().put("cancelled", true))
            return
        }
        try {
            val stream = try {
                activity.contentResolver.openOutputStream(target, "wt")
            } catch (e: Exception) {
                activity.contentResolver.openOutputStream(target, "w")
            } ?: throw IllegalStateException("couldn't open the file")
            synchronized(lock) {
                try { out?.close() } catch (e: Exception) {}
                out = stream
                uri = target
                kind = "document"
            }
            send(JSONObject().put("ready", true).put("name", nameOf(target)))
        } catch (e: Exception) {
            send(JSONObject().put("error", e.message ?: "couldn't open the file"))
        }
    }

    private fun nameOf(target: Uri): String = try {
        activity.contentResolver.query(target, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: ""
    } catch (e: Exception) { "" }

    @JavascriptInterface
    fun write(base64: String): Boolean = synchronized(lock) {
        val stream = out ?: return false
        try {
            stream.write(Base64.decode(base64, Base64.NO_WRAP))
            true
        } catch (e: Exception) { false }
    }

    @JavascriptInterface
    fun end(): Boolean = synchronized(lock) {
        val stream = out ?: return false
        val target = uri
        out = null
        uri = null
        try {
            stream.flush()
            stream.close()
            if (kind == "media" && target != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                activity.contentResolver.update(target, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
            }
            true
        } catch (e: Exception) { false }
    }

    @JavascriptInterface
    fun abort() {
        synchronized(lock) {
            try { out?.close() } catch (e: Exception) {}
            out = null
            val target = uri
            uri = null
            if (target != null) {
                try {
                    when (kind) {
                        "media" -> activity.contentResolver.delete(target, null, null)
                        "file" -> target.path?.let { File(it).delete() }
                        else -> DocumentsContract.deleteDocument(activity.contentResolver, target)
                    }
                } catch (e: Exception) {}
            }
        }
    }

    /* ---------- automatic backups ---------- */

    private fun oldDir(): File? = activity.getExternalFilesDir("backups")?.also { it.mkdirs() }

    @JavascriptInterface
    fun autoWhere(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "Downloads/$AUTO_DIR" else (oldDir()?.absolutePath ?: "")

    @JavascriptInterface
    fun autoBegin(name: String): Boolean {
        if (!AUTO_NAME.matches(name)) return false
        synchronized(lock) {
            try { out?.close() } catch (e: Exception) {}
            out = null
            uri = null
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    val values = ContentValues().apply {
                        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                        put(MediaStore.MediaColumns.MIME_TYPE, "application/zip")
                        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + AUTO_DIR)
                        put(MediaStore.MediaColumns.IS_PENDING, 1)
                    }
                    val target = activity.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
                    out = activity.contentResolver.openOutputStream(target, "w") ?: return false
                    uri = target
                    kind = "media"
                } else {
                    val file = File(oldDir() ?: return false, name)
                    out = FileOutputStream(file)
                    uri = Uri.fromFile(file)
                    kind = "file"
                }
                true
            } catch (e: Exception) { false }
        }
    }

    @JavascriptInterface
    fun autoList(): String {
        val names = JSONArray()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                activity.contentResolver.query(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
                    "${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?",
                    arrayOf(Environment.DIRECTORY_DOWNLOADS + "/" + AUTO_DIR + "/", "Harmonarium-auto-%"),
                    null,
                )?.use { c -> while (c.moveToNext()) c.getString(0)?.let { if (AUTO_NAME.matches(it)) names.put(it) } }
            } else {
                oldDir()?.list()?.filter { AUTO_NAME.matches(it) }?.forEach { names.put(it) }
            }
        } catch (e: Exception) {}
        return names.toString()
    }

    @JavascriptInterface
    fun autoRemove(name: String): Boolean {
        if (!AUTO_NAME.matches(name)) return false
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                activity.contentResolver.delete(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    "${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.DISPLAY_NAME} = ?",
                    arrayOf(Environment.DIRECTORY_DOWNLOADS + "/" + AUTO_DIR + "/", name),
                ) > 0
            } else {
                File(oldDir() ?: return false, name).delete()
            }
        } catch (e: Exception) { false }
    }

    private fun send(detail: JSONObject) {
        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('harmonarium:save', { detail: $detail }))", null,
            )
        }
    }
}
