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
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />

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
            android:launchMode="singleTop"
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
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://signal-frontend-production-a944.up.railway.app";
    private static final String CHANNEL_ID = "recro_media_channel";
    private static final int NOTIFICATION_ID = 101;
    private static final int FILECHOOSER_RESULTCODE = 1;

    private static final String ACTION_PLAY_PAUSE = "app.recro.player.ACTION_PLAY_PAUSE";
    private static final String ACTION_NEXT = "app.recro.player.ACTION_NEXT";
    private static final String ACTION_PREV = "app.recro.player.ACTION_PREV";

    private WebView webView;
    private ValueCallback<Uri[]> uploadMessage;
    private MediaSession mediaSession;
    private NotificationManager notificationManager;

    private String currentTitle = "Recro Track";
    private String currentArtist = "Recro";
    private String currentCoverUrl = "";
    private Bitmap currentCoverBitmap = null;
    private boolean isPlaying = false;
    private long currentPosition = 0;
    private long currentDuration = 0;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final BroadcastReceiver mediaReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent == null || intent.getAction() == null) return;
            String action = intent.getAction();
            if (ACTION_PLAY_PAUSE.equals(action)) {
                sendMediaAction("play_pause");
            } else if (ACTION_NEXT.equals(action)) {
                sendMediaAction("next");
            } else if (ACTION_PREV.equals(action)) {
                sendMediaAction("prev");
            }
        }
    };

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

        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        initNotificationChannel();
        initMediaSession();

        IntentFilter filter = new IntentFilter();
        filter.addAction(ACTION_PLAY_PAUSE);
        filter.addAction(ACTION_NEXT);
        filter.addAction(ACTION_PREV);
        registerReceiver(mediaReceiver, filter);

        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 200);
            }
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

    private void initNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26 && notificationManager != null) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Recro Playback",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Управление воспроизведением музыки Recro");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            notificationManager.createNotificationChannel(channel);
        }
    }

    private void initMediaSession() {
        mediaSession = new MediaSession(this, "RecroMediaSession");
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS | MediaSession.FLAG_HANDLES_MEDIA_BUTTONS);

        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int pFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            pFlags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pIntent = PendingIntent.getActivity(this, 0, intent, pFlags);
        mediaSession.setSessionActivity(pIntent);

        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                sendMediaAction("play");
            }
            @Override
            public void onPause() {
                sendMediaAction("pause");
            }
            @Override
            public void onSkipToNext() {
                sendMediaAction("next");
            }
            @Override
            public void onSkipToPrevious() {
                sendMediaAction("prev");
            }
            @Override
            public void onStop() {
                sendMediaAction("pause");
            }
            @Override
            public void onSeekTo(long pos) {
                sendMediaAction("seekto:" + pos);
            }
        });
    }

    public void sendMediaAction(final String action) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    webView.evaluateJavascript("if(window.recroMediaAction){window.recroMediaAction('" + action + "');}", null);
                }
            }
        });
    }

    private void updateNotification() {
        if (notificationManager == null || mediaSession == null) return;

        int pFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            pFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(this, 0, openIntent, pFlags);

        Intent prevIntent = new Intent(ACTION_PREV);
        PendingIntent pPrev = PendingIntent.getBroadcast(this, 1, prevIntent, pFlags);

        Intent playPauseIntent = new Intent(ACTION_PLAY_PAUSE);
        PendingIntent pPlayPause = PendingIntent.getBroadcast(this, 2, playPauseIntent, pFlags);

        Intent nextIntent = new Intent(ACTION_NEXT);
        PendingIntent pNext = PendingIntent.getBroadcast(this, 3, nextIntent, pFlags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }

        builder.setContentTitle(currentTitle)
               .setContentText(currentArtist)
               .setSmallIcon(R.mipmap.ic_launcher)
               .setContentIntent(pOpen)
               .setVisibility(Notification.VISIBILITY_PUBLIC)
               .setOngoing(isPlaying);

        if (currentCoverBitmap != null) {
            builder.setLargeIcon(currentCoverBitmap);
        }

        builder.addAction(new Notification.Action.Builder(
            android.R.drawable.ic_media_previous, "Previous", pPrev).build());

        int playIcon = isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        String playTitle = isPlaying ? "Pause" : "Play";
        builder.addAction(new Notification.Action.Builder(
            playIcon, playTitle, pPlayPause).build());

        builder.addAction(new Notification.Action.Builder(
            android.R.drawable.ic_media_next, "Next", pNext).build());

        Notification.MediaStyle mediaStyle = new Notification.MediaStyle();
        mediaStyle.setMediaSession(mediaSession.getSessionToken());
        mediaStyle.setShowActionsInCompactView(0, 1, 2);
        builder.setStyle(mediaStyle);

        notificationManager.notify(NOTIFICATION_ID, builder.build());
    }

    private void updateSessionState() {
        if (mediaSession == null) return;

        PlaybackState.Builder psBuilder = new PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY |
                PlaybackState.ACTION_PAUSE |
                PlaybackState.ACTION_PLAY_PAUSE |
                PlaybackState.ACTION_SKIP_TO_NEXT |
                PlaybackState.ACTION_SKIP_TO_PREVIOUS |
                PlaybackState.ACTION_SEEK_TO |
                PlaybackState.ACTION_STOP
            )
            .setState(isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, currentPosition, 1.0f);
        mediaSession.setPlaybackState(psBuilder.build());

        MediaMetadata.Builder mb = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, "Recro")
            .putLong(MediaMetadata.METADATA_KEY_DURATION, currentDuration > 0 ? currentDuration : -1);

        if (currentCoverBitmap != null) {
            mb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, currentCoverBitmap);
            mb.putBitmap(MediaMetadata.METADATA_KEY_ART, currentCoverBitmap);
        }
        mediaSession.setMetadata(mb.build());
        mediaSession.setActive(true);
    }

    private class NativeMediaBridge {
        @JavascriptInterface
        public void updateMediaSession(final String title, final String artist, final String coverUrl,
                                       final boolean playing, final long position, final long duration) {
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    currentTitle = (title != null && !title.isEmpty()) ? title : "Recro Track";
                    currentArtist = (artist != null && !artist.isEmpty()) ? artist : "Recro";
                    isPlaying = playing;
                    currentPosition = position;
                    currentDuration = duration;

                    boolean coverChanged = coverUrl != null && !coverUrl.equals(currentCoverUrl);
                    if (coverChanged) {
                        currentCoverUrl = coverUrl;
                        currentCoverBitmap = null;
                        loadCoverAsync(coverUrl);
                    } else {
                        updateSessionState();
                        updateNotification();
                    }
                }
            });
        }

        @JavascriptInterface
        public void clearMediaSession() {
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    isPlaying = false;
                    currentCoverBitmap = null;
                    currentCoverUrl = "";
                    if (notificationManager != null) {
                        notificationManager.cancel(NOTIFICATION_ID);
                    }
                    if (mediaSession != null) {
                        mediaSession.setActive(false);
                    }
                }
            });
        }
    }

    private void loadCoverAsync(final String coverUrl) {
        updateSessionState();
        updateNotification();

        if (coverUrl == null || coverUrl.isEmpty()) return;

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    URL url = new URL(coverUrl);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(4000);
                    conn.setReadTimeout(4000);
                    conn.setDoInput(true);
                    conn.connect();
                    InputStream input = conn.getInputStream();
                    final Bitmap bitmap = BitmapFactory.decodeStream(input);
                    if (bitmap != null) {
                        mainHandler.post(new Runnable() {
                            @Override
                            public void run() {
                                if (coverUrl.equals(currentCoverUrl)) {
                                    currentCoverBitmap = bitmap;
                                    updateSessionState();
                                    updateNotification();
                                }
                            }
                        });
                    }
                } catch (Exception ignored) {}
            }
        }).start();
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
        s.setUserAgentString(defaultUA + " RecroApp/1.2");

        webView.addJavascriptInterface(new NativeMediaBridge(), "AndroidMediaBridge");

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
        // Do NOT call webView.onPause() so background music and timers stay active!
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try {
            unregisterReceiver(mediaReceiver);
        } catch (Exception ignored) {}
        if (mediaSession != null) {
            mediaSession.release();
        }
        if (notificationManager != null) {
            notificationManager.cancel(NOTIFICATION_ID);
        }
        if (webView != null) {
            webView.destroy();
        }
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
