// Adds Harmonarium's own Android pieces to the project that `tauri android init` generates
// (src-tauri/gen/android is rebuilt in CI, so it isn't committed). Run it right after init:
//   node scripts/android-overlay.mjs
//
// - copies the in-app updater (src-tauri/android/HarmonariumUpdater.kt) and its R8 keep rules
// - registers the updater on the webview as window.HarmonariumUpdater (MainActivity)
// - adds full screen while reading (src-tauri/android/HarmonariumScreen.kt) as window.HarmonariumScreen
// - adds the REQUEST_INSTALL_PACKAGES permission so the updater can open the installer
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src-tauri/android");
const app = path.join(root, "src-tauri/gen/android/app");
const pkgDir = path.join(app, "src/main/java/com/isaakrichards/harmonarium");
const fail = (msg) => { console.error(`android-overlay: ${msg}`); process.exit(1); };

if (!fs.existsSync(pkgDir)) fail(`${pkgDir} not found; run \`tauri android init\` first`);

fs.copyFileSync(path.join(src, "HarmonariumUpdater.kt"), path.join(pkgDir, "HarmonariumUpdater.kt"));
fs.copyFileSync(path.join(src, "HarmonariumScreen.kt"), path.join(pkgDir, "HarmonariumScreen.kt"));
fs.copyFileSync(path.join(src, "HarmonariumFolder.kt"), path.join(pkgDir, "HarmonariumFolder.kt"));
fs.copyFileSync(path.join(src, "harmonarium-updater.pro"), path.join(app, "harmonarium-updater.pro"));

// MainActivity: hook the webview as it is created, before the page loads.
const mainPath = path.join(pkgDir, "MainActivity.kt");
let main = fs.readFileSync(mainPath, "utf8");
if (!main.includes("HarmonariumUpdater(")) {
  const end = main.lastIndexOf("}");
  if (end < 0) fail("unexpected MainActivity.kt");
  main = main.slice(0, end).trimEnd() + `

  private var harmonariumFolder: HarmonariumFolder? = null

  override fun onWebViewCreate(webView: android.webkit.WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(HarmonariumUpdater(this, webView), "HarmonariumUpdater")
    webView.addJavascriptInterface(HarmonariumScreen(this), "HarmonariumScreen")
    harmonariumFolder = HarmonariumFolder(this, webView).also { webView.addJavascriptInterface(it, "HarmonariumFolder") }
  }

  @Deprecated("Activity results still arrive here for startActivityForResult")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: android.content.Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode == HarmonariumFolder.REQUEST) harmonariumFolder?.onResult(resultCode, data)
  }
}
`;
  fs.writeFileSync(mainPath, main);
}

// Manifest: permission to hand APKs to the installer. The template's FileProvider (cache-path ".")
// already covers the cache folder the updater downloads into.
const manPath = path.join(app, "src/main/AndroidManifest.xml");
let man = fs.readFileSync(manPath, "utf8");
if (!man.includes("androidx.core.content.FileProvider") || !man.includes("${applicationId}.fileprovider")) {
  fail("the generated manifest no longer has Tauri's FileProvider; the updater needs one");
}
if (!man.includes("REQUEST_INSTALL_PACKAGES")) {
  man = man.replace(
    /(<uses-permission android:name="android.permission.INTERNET"\s*\/>)/,
    `$1\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />`,
  );
  if (!man.includes("REQUEST_INSTALL_PACKAGES")) fail("couldn't add REQUEST_INSTALL_PACKAGES to the manifest");
  fs.writeFileSync(manPath, man);
}
const paths = path.join(app, "src/main/res/xml/file_paths.xml");
if (fs.existsSync(paths) && !fs.readFileSync(paths, "utf8").includes("<cache-path")) {
  fail("file_paths.xml has no cache-path; the updater downloads into the cache folder");
}

console.log("android-overlay: updater, full-screen reading and folder adding added");
