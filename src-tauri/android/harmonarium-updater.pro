# Keep the methods the page calls on window.HarmonariumUpdater (R8 would otherwise strip or rename them).
-keepclassmembers class com.isaakrichards.harmonarium.HarmonariumUpdater {
    @android.webkit.JavascriptInterface <methods>;
}

# …and on window.HarmonariumScreen (full screen while reading).
-keepclassmembers class com.isaakrichards.harmonarium.HarmonariumScreen {
    @android.webkit.JavascriptInterface <methods>;
}
