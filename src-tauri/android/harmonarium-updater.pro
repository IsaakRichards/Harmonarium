# Keep the methods the page calls on window.HarmonariumUpdater (R8 would otherwise strip or rename them).
-keepclassmembers class com.isaakrichards.harmonarium.HarmonariumUpdater {
    @android.webkit.JavascriptInterface <methods>;
}
