#!/usr/bin/env bash
# Recro — Android APK Build Script
# Compiles a high-performance native WebView wrapper for Recro with Foreground Media Service into frontend/public/recro.apk
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

# 1. Ensure android-34.jar & r8.jar
ANDROID_JAR="$CACHE_DIR/android-34.jar"
if [ ! -f "$ANDROID_JAR" ]; then
  echo "📥 Downloading android-34 framework jar..."
  curl -sSL "https://raw.githubusercontent.com/Sable/android-platforms/master/android-34/android.jar" -o "$ANDROID_JAR"
fi

R8_JAR="$CACHE_DIR/r8.jar"
if [ ! -f "$R8_JAR" ]; then
  echo "📥 Downloading D8/R8 dex compiler..."
  curl -sSL "https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.2.42/r8-8.2.42.jar" -o "$R8_JAR"
fi

# 2. Locate aapt2 & apksigner
if [ -x "/nix/store/7rnp0zvhymg9nlgw4rw54d4q1lp0rivg-aapt-8.13.2-14304508/bin/aapt2" ]; then
  AAPT2="/nix/store/7rnp0zvhymg9nlgw4rw54d4q1lp0rivg-aapt-8.13.2-14304508/bin/aapt2"
else
  AAPT2="$(which aapt2 2>/dev/null || find /nix/store -maxdepth 3 -name "aapt2" -type f -executable 2>/dev/null | head -n 1 || true)"
fi

if [ -x "/nix/store/di5byrj3mngm00a0d9i84k6zjmn6hpmy-apksigner-35.0.6/bin/apksigner" ]; then
  APKSIGNER="/nix/store/di5byrj3mngm00a0d9i84k6zjmn6hpmy-apksigner-35.0.6/bin/apksigner"
else
  APKSIGNER="$(which apksigner 2>/dev/null || find /nix/store -maxdepth 3 -name "apksigner" -type f -executable 2>/dev/null | head -n 1 || true)"
fi

if [ -z "$AAPT2" ]; then
  echo "❌ aapt2 not found."
  exit 1
fi

if [ -z "$APKSIGNER" ]; then
  echo "❌ apksigner not found."
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
         "$BUILD_DIR/res/drawable" \
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
  cp "$FRONTEND_DIR/public/icons/icon-192.png" "$BUILD_DIR/res/drawable/ic_launcher.png"
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
    android:versionCode="3"
    android:versionName="1.2.0">

    <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="34" />

    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
    <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
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

        <service
            android:name=".MediaPlaybackService"
            android:foregroundServiceType="mediaPlayback"
            android:exported="false" />
    </application>
</manifest>
EOF

# 7. MediaPlaybackService.java
cat << 'EOF' > "$BUILD_DIR/src/app/recro/player/MediaPlaybackService.java"
package app.recro.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MediaPlaybackService extends Service {
    private static final String TAG = "RecroService";
    private static final String CHANNEL_ID = "recro_media_channel";
    private static final int NOTIFICATION_ID = 101;

    public static final String ACTION_UPDATE = "app.recro.player.ACTION_UPDATE";
    public static final String ACTION_STOP = "app.recro.player.ACTION_STOP";
    public static final String ACTION_PLAY_PAUSE = "app.recro.player.ACTION_PLAY_PAUSE";
    public static final String ACTION_NEXT = "app.recro.player.ACTION_NEXT";
    public static final String ACTION_PREV = "app.recro.player.ACTION_PREV";

    private MediaSession mediaSession;
    private NotificationManager notificationManager;
    private PowerManager.WakeLock wakeLock;

    private String currentTitle = "Recro Track";
    private String currentArtist = "Recro";
    private String currentCoverUrl = "";
    private Bitmap currentCoverBitmap = null;
    private boolean isPlaying = false;
    private long currentPosition = 0;
    private long currentDuration = 0;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        initNotificationChannel();
        initMediaSession();
        initWakeLock();
    }

    private void initNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26 && notificationManager != null) {
            try {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Recro Playback",
                    NotificationManager.IMPORTANCE_LOW
                );
                channel.setDescription("Воспроизведение музыки Recro");
                channel.setShowBadge(false);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                channel.enableVibration(false);
                channel.setSound(null, null);
                notificationManager.createNotificationChannel(channel);
            } catch (Throwable t) {
                Log.e(TAG, "Failed to create notification channel", t);
            }
        }
    }

    private void initMediaSession() {
        try {
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
                    MainActivity.sendMediaAction("play");
                }
                @Override
                public void onPause() {
                    MainActivity.sendMediaAction("pause");
                }
                @Override
                public void onSkipToNext() {
                    MainActivity.sendMediaAction("next");
                }
                @Override
                public void onSkipToPrevious() {
                    MainActivity.sendMediaAction("prev");
                }
                @Override
                public void onStop() {
                    MainActivity.sendMediaAction("pause");
                }
                @Override
                public void onSeekTo(long pos) {
                    MainActivity.sendMediaAction("seekto:" + pos);
                }
            });
            mediaSession.setActive(true);
        } catch (Throwable t) {
            Log.e(TAG, "Failed to initialize MediaSession", t);
        }
    }

    private void initWakeLock() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "recro:media_lock");
                wakeLock.setReferenceCounted(false);
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to initialize WakeLock", t);
        }
    }

    private void acquireWakeLock() {
        try {
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(12 * 60 * 60 * 1000L); // 12 hours max
            }
        } catch (Throwable ignored) {}
    }

    private void releaseWakeLock() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Throwable ignored) {}
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || intent.getAction() == null) {
            return START_STICKY;
        }

        String action = intent.getAction();
        if (ACTION_PLAY_PAUSE.equals(action)) {
            MainActivity.sendMediaAction("play_pause");
        } else if (ACTION_NEXT.equals(action)) {
            MainActivity.sendMediaAction("next");
        } else if (ACTION_PREV.equals(action)) {
            MainActivity.sendMediaAction("prev");
        } else if (ACTION_STOP.equals(action)) {
            stopPlaybackInternal();
        } else if (ACTION_UPDATE.equals(action)) {
            String title = intent.getStringExtra("title");
            String artist = intent.getStringExtra("artist");
            String coverUrl = intent.getStringExtra("coverUrl");
            boolean playing = intent.getBooleanExtra("playing", false);
            long pos = intent.getLongExtra("position", 0);
            long dur = intent.getLongExtra("duration", 0);
            handleUpdate(title, artist, coverUrl, playing, pos, dur);
        }

        return START_STICKY;
    }

    private void handleUpdate(String title, String artist, final String coverUrl,
                              boolean playing, long position, long duration) {
        currentTitle = (title != null && !title.trim().isEmpty()) ? title : "Recro Track";
        currentArtist = (artist != null && !artist.trim().isEmpty()) ? artist : "Recro";
        isPlaying = playing;
        currentPosition = position;
        currentDuration = duration;

        boolean coverChanged = (coverUrl != null && !coverUrl.equals(currentCoverUrl));
        if (coverChanged) {
            currentCoverUrl = coverUrl;
            currentCoverBitmap = null;
            loadCoverAsync(coverUrl);
        }

        updateSessionState();
        Notification notif = buildNotification();

        if (isPlaying) {
            try {
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(NOTIFICATION_ID, notif, 2 /* FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK */);
                } else {
                    startForeground(NOTIFICATION_ID, notif);
                }
            } catch (Throwable t) {
                try {
                    startForeground(NOTIFICATION_ID, notif);
                } catch (Throwable t2) {
                    if (notificationManager != null) {
                        notificationManager.notify(NOTIFICATION_ID, notif);
                    }
                }
            }
            acquireWakeLock();
        } else {
            try {
                if (Build.VERSION.SDK_INT >= 24) {
                    stopForeground(false); // Detach foreground but keep notification in shade!
                }
            } catch (Throwable ignored) {}
            if (notificationManager != null) {
                try {
                    notificationManager.notify(NOTIFICATION_ID, notif);
                } catch (Throwable ignored) {}
            }
            releaseWakeLock();
        }
    }

    private void updateSessionState() {
        if (mediaSession == null) return;
        try {
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
                .setState(isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                          currentPosition, 1.0f);
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
        } catch (Throwable t) {
            Log.e(TAG, "Failed to update session state", t);
        }
    }

    private Notification buildNotification() {
        int pFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            pFlags |= PendingIntent.FLAG_IMMUTABLE;
        }

        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pOpen = PendingIntent.getActivity(this, 0, openIntent, pFlags);

        Intent prevIntent = new Intent(this, MediaPlaybackService.class);
        prevIntent.setAction(ACTION_PREV);
        PendingIntent pPrev = PendingIntent.getService(this, 1, prevIntent, pFlags);

        Intent playPauseIntent = new Intent(this, MediaPlaybackService.class);
        playPauseIntent.setAction(ACTION_PLAY_PAUSE);
        PendingIntent pPlayPause = PendingIntent.getService(this, 2, playPauseIntent, pFlags);

        Intent nextIntent = new Intent(this, MediaPlaybackService.class);
        nextIntent.setAction(ACTION_NEXT);
        PendingIntent pNext = PendingIntent.getService(this, 3, nextIntent, pFlags);

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= 26) {
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }

        builder.setContentTitle(currentTitle)
               .setContentText(currentArtist)
               .setSmallIcon(android.R.drawable.ic_media_play)
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

        if (mediaSession != null) {
            try {
                Notification.MediaStyle mediaStyle = new Notification.MediaStyle();
                mediaStyle.setMediaSession(mediaSession.getSessionToken());
                mediaStyle.setShowActionsInCompactView(0, 1, 2);
                builder.setStyle(mediaStyle);
            } catch (Throwable t) {
                Log.e(TAG, "Failed to set MediaStyle", t);
            }
        }

        return builder.build();
    }

    private void loadCoverAsync(final String coverUrl) {
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
                                    if (notificationManager != null) {
                                        try {
                                            notificationManager.notify(NOTIFICATION_ID, buildNotification());
                                        } catch (Throwable ignored) {}
                                    }
                                }
                            }
                        });
                    }
                } catch (Throwable ignored) {}
            }
        }).start();
    }

    private void stopPlaybackInternal() {
        isPlaying = false;
        currentCoverBitmap = null;
        currentCoverUrl = "";
        releaseWakeLock();
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                stopForeground(true);
            } else {
                stopForeground(true);
            }
        } catch (Throwable ignored) {}
        if (notificationManager != null) {
            try {
                notificationManager.cancel(NOTIFICATION_ID);
            } catch (Throwable ignored) {}
        }
        if (mediaSession != null) {
            try {
                mediaSession.setActive(false);
            } catch (Throwable ignored) {}
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopPlaybackInternal();
        if (mediaSession != null) {
            try {
                mediaSession.release();
            } catch (Throwable ignored) {}
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public static void updatePlayback(final Context context, final String title, final String artist,
                                       final String coverUrl, final boolean playing,
                                       final long position, final long duration) {
        if (context == null) return;
        try {
            Intent intent = new Intent(context, MediaPlaybackService.class);
            intent.setAction(ACTION_UPDATE);
            intent.putExtra("title", title);
            intent.putExtra("artist", artist);
            intent.putExtra("coverUrl", coverUrl);
            intent.putExtra("playing", playing);
            intent.putExtra("position", position);
            intent.putExtra("duration", duration);

            if (Build.VERSION.SDK_INT >= 26 && playing) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Throwable t) {
            Log.e(TAG, "Failed to updatePlayback", t);
        }
    }

    public static void stop(final Context context) {
        if (context == null) return;
        try {
            Intent intent = new Intent(context, MediaPlaybackService.class);
            intent.setAction(ACTION_STOP);
            context.startService(intent);
        } catch (Throwable t) {
            Log.e(TAG, "Failed to stop service", t);
        }
    }
}
EOF

# 8. MainActivity.java
cat << 'EOF' > "$BUILD_DIR/src/app/recro/player/MainActivity.java"
package app.recro.player;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
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

public class MainActivity extends Activity {
    private static final String APP_URL = "https://signal-frontend-production-a944.up.railway.app";
    private static final int FILECHOOSER_RESULTCODE = 1;

    private static MainActivity sInstance;
    private WebView webView;
    private ValueCallback<Uri[]> uploadMessage;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public static void sendMediaAction(final String action) {
        if (sInstance != null && sInstance.webView != null && action != null) {
            sInstance.mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        sInstance.webView.evaluateJavascript(
                            "if(window.recroMediaAction){window.recroMediaAction('" + action + "');}", null);
                    } catch (Throwable t) {
                        Log.e("RecroApp", "Error sending media action: " + action, t);
                    }
                }
            });
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        sInstance = this;

        // Global uncaught exception protection: prevent instant crashes
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread thread, Throwable throwable) {
                Log.e("RecroApp", "Uncaught exception safely caught", throwable);
            }
        });

        try {
            requestWindowFeature(Window.FEATURE_NO_TITLE);
            if (Build.VERSION.SDK_INT >= 21) {
                Window window = getWindow();
                window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
                window.setStatusBarColor(Color.parseColor("#09090b"));
                window.setNavigationBarColor(Color.parseColor("#09090b"));
            }
        } catch (Throwable ignored) {}

        if (Build.VERSION.SDK_INT >= 33) {
            try {
                if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 200);
                }
            } catch (Throwable ignored) {}
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
            if (webView.restoreState(savedInstanceState) == null) {
                webView.loadUrl(APP_URL);
            }
        }
    }

    private class NativeMediaBridge {
        @JavascriptInterface
        public void updateMediaSession(final String title, final String artist, final String coverUrl,
                                       final boolean playing, final long position, final long duration) {
            MediaPlaybackService.updatePlayback(MainActivity.this, title, artist, coverUrl, playing, position, duration);
        }

        @JavascriptInterface
        public void clearMediaSession() {
            MediaPlaybackService.stop(MainActivity.this);
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
        s.setUserAgentString(defaultUA + " RecroApp/1.2");

        webView.addJavascriptInterface(new NativeMediaBridge(), "AndroidMediaBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url == null) return false;
                if (url.startsWith("https://signal-frontend-production-a944.up.railway.app") ||
                    url.startsWith("https://accounts.google.com") ||
                    url.startsWith("http://localhost") ||
                    url.startsWith("blob:") ||
                    url.startsWith("data:")) {
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
        if (webView != null) webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Do NOT call webView.onPause() so background music and timers stay active!
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (sInstance == this) {
            sInstance = null;
        }
        if (webView != null) {
            try {
                webView.destroy();
            } catch (Throwable ignored) {}
        }
    }
}
EOF

# 9. Compile and link resources
echo "📦 [1/4] Compiling resources with aapt2..."
"$AAPT2" compile --dir "$BUILD_DIR/res" -o "$BUILD_DIR/compiled/resources.zip"

echo "🔗 [2/4] Linking resources and generating R.java..."
"$AAPT2" link "$BUILD_DIR/compiled/resources.zip" \
  -I "$ANDROID_JAR" \
  --manifest "$BUILD_DIR/AndroidManifest.xml" \
  --java "$BUILD_DIR/gen" \
  -o "$BUILD_DIR/bin/unaligned.apk"

# 10. Compile Java & Dex with D8
echo "☕ [3/4] Compiling Java and generating DEX bytecode..."
javac --release 8 -cp "$ANDROID_JAR" -d "$BUILD_DIR/obj" \
  "$BUILD_DIR/gen/app/recro/player/R.java" \
  "$BUILD_DIR/src/app/recro/player/MainActivity.java" \
  "$BUILD_DIR/src/app/recro/player/MediaPlaybackService.java"

java -cp "$R8_JAR" com.android.tools.r8.D8 \
  --lib "$ANDROID_JAR" \
  --output "$BUILD_DIR/bin" \
  --min-api 21 \
  $(find "$BUILD_DIR/obj" -name "*.class")

# 11. Package & Sign APK
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

# 12. Copy to frontend/public/recro.apk
cp "$BUILD_DIR/recro.apk" "$FRONTEND_DIR/public/recro.apk"
if [ -d "$FRONTEND_DIR/dist/browser" ]; then
  cp "$BUILD_DIR/recro.apk" "$FRONTEND_DIR/dist/browser/recro.apk"
fi
if [ -d "$FRONTEND_DIR/dist/frontend/browser" ]; then
  cp "$BUILD_DIR/recro.apk" "$FRONTEND_DIR/dist/frontend/browser/recro.apk"
fi

SIZE="$(du -h "$FRONTEND_DIR/public/recro.apk" | cut -f1)"
echo "══════════════════════════════════════════════════════"
echo "  ✅ APK successfully built and installed to:"
echo "     frontend/public/recro.apk ($SIZE)"
echo "══════════════════════════════════════════════════════"
