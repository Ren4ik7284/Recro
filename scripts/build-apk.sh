#!/usr/bin/env bash
# Recro — Android APK Build Script
# Compiles a lightweight native WebView wrapper for Recro into frontend/public/recro.apk
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
CACHE_DIR="${HOME}/.cache/android-build-tools"
BUILD_DIR="/tmp/recro-apk-build"

echo "══════════════════════════════════════════════════════"
echo "  🎵 Recro — Native Android APK Builder"
echo "══════════════════════════════════════════════════════"

mkdir -p "$CACHE_DIR" "$BUILD_DIR"

# 1. Ensure android.jar & r8.jar
if [ ! -f "$CACHE_DIR/android.jar" ]; then
  echo "📥 Downloading android-28 framework jar..."
  curl -sSL "https://raw.githubusercontent.com/Sable/android-platforms/master/android-28/android.jar" -o "$CACHE_DIR/android.jar"
fi

if [ ! -f "$CACHE_DIR/r8.jar" ]; then
  echo "📥 Downloading D8/R8 dex compiler..."
  curl -sSL "https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.2.42/r8-8.2.42.jar" -o "$CACHE_DIR/r8.jar"
fi

ANDROID_JAR="$CACHE_DIR/android.jar"
R8_JAR="$CACHE_DIR/r8.jar"

# 2. Locate aapt2 & apksigner
AAPT2="$(which aapt2 2>/dev/null || find /nix/store -name "aapt2" -type f -executable 2>/dev/null | head -n 1 || true)"
APKSIGNER="$(which apksigner 2>/dev/null || find /nix/store -name "apksigner" -type f -executable 2>/dev/null | head -n 1 || true)"

if [ -z "$AAPT2" ]; then
  echo "❌ aapt2 not found. Please install aapt2 (e.g. nix-shell -p aapt)."
  exit 1
fi

if [ -z "$APKSIGNER" ]; then
  echo "❌ apksigner not found. Please install apksigner (e.g. nix-shell -p apksigner)."
  exit 1
fi

echo "  ✓ AAPT2: $AAPT2"
echo "  ✓ APKSIGNER: $APKSIGNER"
echo "  ✓ ANDROID_JAR: $ANDROID_JAR"
echo "  ✓ R8_JAR: $R8_JAR"

# 3. Clean and prepare build directories
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/src/app/recro/player" \
         "$BUILD_DIR/res/values" \
         "$BUILD_DIR/res/mipmap-hdpi" \
         "$BUILD_DIR/res/mipmap-xhdpi" \
         "$BUILD_DIR/res/mipmap-xxhdpi" \
         "$BUILD_DIR/compiled" \
         "$BUILD_DIR/gen" \
         "$BUILD_DIR/obj" \
         "$BUILD_DIR/bin"

# 4. Copy app icon
if [ -f "$FRONTEND_DIR/public/icons/icon-192.png" ]; then
  cp "$FRONTEND_DIR/public/icons/icon-192.png" "$BUILD_DIR/res/mipmap-hdpi/ic_launcher.png"
  cp "$FRONTEND_DIR/public/icons/icon-192.png" "$BUILD_DIR/res/mipmap-xhdpi/ic_launcher.png"
fi
if [ -f "$FRONTEND_DIR/public/icons/icon-512.png" ]; then
  cp "$FRONTEND_DIR/public/icons/icon-512.png" "$BUILD_DIR/res/mipmap-xxhdpi/ic_launcher.png"
fi

# 5. strings.xml
cat << 'EOF' > "$BUILD_DIR/res/values/strings.xml"
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">Recro</string>
</resources>
EOF

# 6. AndroidManifest.xml
cat << 'EOF' > "$BUILD_DIR/AndroidManifest.xml"
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="app.recro.player"
    android:versionCode="2"
    android:versionName="1.1.0">

    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />

    <application
        android:label="@string/app_name"
        android:icon="@mipmap/ic_launcher"
        android:hardwareAccelerated="true"
        android:usesCleartextTraffic="true"
        android:theme="@android:style/Theme.Black.NoTitleBar">
        <activity
            android:name=".MainActivity"
            android:configChanges="orientation|screenSize|keyboardHidden|screenLayout"
            android:windowSoftInputMode="adjustResize"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
EOF

# 7. MainActivity.java
cat << 'EOF' > "$BUILD_DIR/src/app/recro/player/MainActivity.java"
package app.recro.player;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://signal-frontend-production-a944.up.railway.app";
    private WebView webView;
    private ValueCallback<Uri[]> uploadMessage;
    private final static int FILECHOOSER_RESULTCODE = 1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        if (Build.VERSION.SDK_INT >= 21) {
            Window window = getWindow();
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.parseColor("#09090b"));
            window.setNavigationBarColor(Color.parseColor("#09090b"));
        }

        FrameLayout container = new FrameLayout(this);
        container.setBackgroundColor(Color.parseColor("#09090b"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#09090b"));
        setupWebView();

        container.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));

        setContentView(container);

        if (savedInstanceState == null) {
            webView.loadUrl(APP_URL);
        } else {
            webView.restoreState(savedInstanceState);
        }
    }

    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setSupportMultipleWindows(false);

        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        String defaultUA = s.getUserAgentString();
        s.setUserAgentString(defaultUA + " RecroApp/1.1");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("https://signal-frontend-production-a944.up.railway.app") ||
                    url.startsWith("https://accounts.google.com") ||
                    url.startsWith("http://localhost")) {
                    return false;
                }
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                    startActivity(intent);
                    return true;
                } catch (Exception e) {
                    return false;
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback,
                                              FileChooserParams fileChooserParams) {
                if (uploadMessage != null) {
                    uploadMessage.onReceiveValue(null);
                }
                uploadMessage = filePathCallback;
                try {
                    Intent intent = fileChooserParams.createIntent();
                    startActivityForResult(intent, FILECHOOSER_RESULTCODE);
                    return true;
                } catch (Exception e) {
                    uploadMessage = null;
                    return false;
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILECHOOSER_RESULTCODE) {
            if (uploadMessage != null) {
                uploadMessage.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                uploadMessage = null;
            }
        } else {
            super.onActivityResult(requestCode, resultCode, data);
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }
}
EOF

# 8. Compile and link resources
echo "📦 [1/4] Compiling resources with aapt2..."
"$AAPT2" compile --dir "$BUILD_DIR/res" -o "$BUILD_DIR/compiled/resources.zip"

echo "🔗 [2/4] Linking resources and generating R.java..."
"$AAPT2" link "$BUILD_DIR/compiled/resources.zip" \
  -I "$ANDROID_JAR" \
  --manifest "$BUILD_DIR/AndroidManifest.xml" \
  --java "$BUILD_DIR/gen" \
  -o "$BUILD_DIR/bin/unaligned.apk"

# 9. Compile Java & Dex with D8
echo "☕ [3/4] Compiling Java and generating DEX bytecode..."
javac --release 8 -cp "$ANDROID_JAR" -d "$BUILD_DIR/obj" \
  "$BUILD_DIR/gen/app/recro/player/R.java" \
  "$BUILD_DIR/src/app/recro/player/MainActivity.java"

java -cp "$R8_JAR" com.android.tools.r8.D8 \
  --lib "$ANDROID_JAR" \
  --output "$BUILD_DIR/bin" \
  --min-api 21 \
  $(find "$BUILD_DIR/obj" -name "*.class")

# 10. Package & Sign APK
echo "🔏 [4/4] Adding DEX and signing APK..."
cd "$BUILD_DIR/bin"
jar uf unaligned.apk classes.dex

KEYSTORE="$ROOT_DIR/scripts/recro.keystore"
if [ ! -f "$KEYSTORE" ]; then
  keytool -genkeypair -keystore "$KEYSTORE" -storepass recromusic -keypass recromusic \
    -alias recro -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Recro,OU=Player,O=Recro,L=Moscow,ST=RU,C=RU" 2>/dev/null
fi

"$APKSIGNER" sign --ks "$KEYSTORE" --ks-pass pass:recromusic --key-pass pass:recromusic \
  --ks-key-alias recro --out "$BUILD_DIR/recro.apk" unaligned.apk

"$APKSIGNER" verify "$BUILD_DIR/recro.apk"

# 11. Copy to frontend/public/recro.apk
cp "$BUILD_DIR/recro.apk" "$FRONTEND_DIR/public/recro.apk"
if [ -d "$FRONTEND_DIR/dist/browser" ]; then
  cp "$BUILD_DIR/recro.apk" "$FRONTEND_DIR/dist/browser/recro.apk"
fi

SIZE="$(du -h "$FRONTEND_DIR/public/recro.apk" | cut -f1)"
echo "══════════════════════════════════════════════════════"
echo "  ✅ APK successfully built and installed to:"
echo "     frontend/public/recro.apk ($SIZE)"
echo "══════════════════════════════════════════════════════"
