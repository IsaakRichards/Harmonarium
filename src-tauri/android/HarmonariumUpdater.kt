package com.isaakrichards.harmonarium

// In-app updater for the Android build.
//
// scripts/android-overlay.mjs copies this file into the generated Android project and registers it
// on the webview as `window.HarmonariumUpdater`. The page (src/updater.js) asks GitHub which release is
// newest; this class only downloads that release's Harmonarium.apk and hands it to the system installer.
// Progress is reported back as `harmonarium:update` events on `window`.

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class HarmonariumUpdater(private val activity: Activity, private val webView: WebView) {
    companion object {
        /** Only release assets from this repository are ever downloaded. */
        private const val ALLOWED_PREFIX = "https://github.com/IsaakRichards/Harmonarium/releases/download/"
    }

    @Volatile private var busy = false
    private val dir get() = File(activity.cacheDir, "updates")
    private val apk get() = File(dir, "Harmonarium.apk")

    @JavascriptInterface
    fun versionName(): String = try {
        activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: ""
    } catch (e: Exception) { "" }

    /** Android 8+ asks once per app before it may install APKs ("Install unknown apps"). */
    @JavascriptInterface
    fun canInstall(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || activity.packageManager.canRequestPackageInstalls()

    @JavascriptInterface
    fun openInstallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        activity.runOnUiThread {
            try {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            } catch (e: Exception) {
                emit("error", "message" to "Couldn't open the permission screen: ${e.message}")
            }
        }
    }

    /** True when an APK from an earlier download is waiting to be installed. */
    @JavascriptInterface
    fun hasDownload(): Boolean = apk.isFile

    /** Downloads the APK in the background, then opens the installer. Returns false if refused. */
    @JavascriptInterface
    fun download(url: String): Boolean {
        if (busy || !url.startsWith(ALLOWED_PREFIX)) return false
        busy = true
        thread(name = "harmonarium-update") {
            try {
                dir.mkdirs()
                dir.listFiles()?.forEach { it.delete() }
                val part = File(dir, "Harmonarium.apk.part")
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = true // GitHub redirects to its asset host (https → https)
                    connectTimeout = 20_000
                    readTimeout = 30_000
                    setRequestProperty("Accept", "application/octet-stream")
                }
                if (conn.responseCode !in 200..299) throw Exception("HTTP ${conn.responseCode}")
                val total = conn.contentLengthLong
                var done = 0L
                var lastPct = -1
                conn.inputStream.use { input ->
                    part.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            val pct = if (total > 0) (done * 100 / total).toInt() else -1
                            if (pct != lastPct) { lastPct = pct; emit("progress", "percent" to pct, "bytes" to done, "total" to total) }
                        }
                    }
                }
                conn.disconnect()

                // Make sure it really is a Harmonarium APK before offering to install it.
                val info = activity.packageManager.getPackageArchiveInfo(part.path, 0)
                if (info == null || info.packageName != activity.packageName) {
                    part.delete()
                    throw Exception("The download isn't a Harmonarium APK")
                }
                if (!part.renameTo(apk)) throw Exception("Couldn't save the download")
                emit("downloaded", "version" to (info.versionName ?: ""))
                busy = false
                install()
            } catch (e: Exception) {
                busy = false
                emit("error", "message" to (e.message ?: "Download failed"))
            }
        }
        return true
    }

    /** Opens the system installer for the downloaded APK (asking for permission first if needed). */
    @JavascriptInterface
    fun install(): Boolean {
        if (!apk.isFile) return false
        if (!canInstall()) {
            emit("permission")
            openInstallPermission()
            return false
        }
        activity.runOnUiThread {
            try {
                val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
                activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
                })
                emit("installing")
            } catch (e: Exception) {
                emit("error", "message" to "Couldn't open the installer: ${e.message}")
            }
        }
        return true
    }

    private fun emit(state: String, vararg extra: Pair<String, Any>) {
        val json = JSONObject().put("state", state)
        for ((k, v) in extra) json.put(k, v)
        val js = "window.dispatchEvent(new CustomEvent('harmonarium:update',{detail:$json}))"
        webView.post { webView.evaluateJavascript(js, null) }
    }
}
