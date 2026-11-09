# Keep the methods the page calls on window.StarbornUpdater (R8 would otherwise strip or rename them).
-keepclassmembers class com.isaakrichards.starborn.StarbornUpdater {
    @android.webkit.JavascriptInterface <methods>;
}
