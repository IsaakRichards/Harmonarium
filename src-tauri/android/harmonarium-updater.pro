# Keep the methods the page calls on window.HarmonariumUpdater (R8 would otherwise strip or rename them).
-keepclassmembers class com.isaakrichards.harmonarium.HarmonariumUpdater {
    @android.webkit.JavascriptInterface <methods>;
}

# …and on window.HarmonariumScreen (full screen while reading).
-keepclassmembers class com.isaakrichards.harmonarium.HarmonariumScreen {
    @android.webkit.JavascriptInterface <methods>;
}

# …and on window.HarmonariumFolder (adding a whole folder of books).
-keepclassmembers class com.isaakrichards.harmonarium.HarmonariumFolder {
    @android.webkit.JavascriptInterface <methods>;
}

# …and on window.HarmonariumSave (saving a backup).
-keepclassmembers class com.isaakrichards.harmonarium.HarmonariumSave {
    @android.webkit.JavascriptInterface <methods>;
}
