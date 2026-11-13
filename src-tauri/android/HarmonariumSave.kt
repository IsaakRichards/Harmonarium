package com.isaakrichards.harmonarium

// Saving a file the app made (a backup) on Android.
//
// scripts/android-overlay.mjs copies this file into the generated Android project, registers it on
// the webview as `window.HarmonariumSave`, and passes MainActivity's activity results to it.
// begin(name, mime) opens the system's "save as" screen; the answer comes back as a
// `harmonarium:save` event: { ready: true, name } or { cancelled: true } or { error }.
// The page then sends the file in pieces with write(base64) and finishes with end(), or abort()
// to throw the half-written file away.

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.OutputStream

class HarmonariumSave(private val activity: Activity, private val webView: WebView) {
    companion object {
        const val REQUEST = 0x4853 // "HS"
    }

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
        out = null
        uri = null
        try {
            stream.flush()
            stream.close()
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
                try { DocumentsContract.deleteDocument(activity.contentResolver, target) } catch (e: Exception) {}
            }
        }
    }

    private fun send(detail: JSONObject) {
        webView.post {
            webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('harmonarium:save', { detail: $detail }))", null,
            )
        }
    }
}
