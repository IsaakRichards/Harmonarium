package com.isaakrichards.harmonarium

import android.app.Activity
import android.os.Build
import android.view.WindowManager
import android.webkit.JavascriptInterface
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Full screen while reading, as in ReadEra: the page calls window.HarmonariumScreen.setImmersive(true)
 * when a book opens and false when it closes. Android's status and navigation bars hide; a swipe
 * from the edge shows them for a moment.
 */
class HarmonariumScreen(private val activity: Activity) {
  @JavascriptInterface
  fun setImmersive(on: Boolean) {
    activity.runOnUiThread {
      val window = activity.window
      val controller = WindowCompat.getInsetsController(window, window.decorView)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        // Let the page run under a notch or camera hole while the bars are away.
        window.attributes = window.attributes.apply {
          layoutInDisplayCutoutMode = if (on) WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
          else WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
        }
      }
      if (on) {
        controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        controller.hide(WindowInsetsCompat.Type.systemBars())
      } else {
        controller.show(WindowInsetsCompat.Type.systemBars())
      }
    }
  }
}
