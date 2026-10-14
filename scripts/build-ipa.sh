#!/usr/bin/env bash
# Recro — iOS IPA Build Script
# Compiles a native iOS Mach-O WebView wrapper with background audio support and packages it into frontend/public/recro.ipa
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRONTEND_DIR="$ROOT_DIR/frontend"
BUILD_DIR="/tmp/recro-ipa-build"

echo "══════════════════════════════════════════════════════"
echo "  🍏 Recro — Native iOS IPA Package Builder"
echo "══════════════════════════════════════════════════════"

# 1. Locate Clang, ld64.lld, and zip
CLANG="$(which clang 2>/dev/null || find /nix/store -maxdepth 4 -name "clang" -type f -executable 2>/dev/null | grep -E '/bin/clang$' | head -n 1 || true)"
LD64="$(which ld64.lld 2>/dev/null || [ -x "/nix/store/1jib3n4b8k199ga8bg20zdpfvz0ajlrk-rustc-bootstrap-1.94.0/lib/rustlib/x86_64-unknown-linux-gnu/bin/gcc-ld/ld64.lld" ] && echo "/nix/store/1jib3n4b8k199ga8bg20zdpfvz0ajlrk-rustc-bootstrap-1.94.0/lib/rustlib/x86_64-unknown-linux-gnu/bin/gcc-ld/ld64.lld" || find /nix/store -maxdepth 8 -name "ld64.lld" -type f -executable 2>/dev/null | head -n 1 || true)"
ZIP="$(which zip 2>/dev/null || [ -x "/nix/store/chqyzmw0g42i2v9r4lf38azn73w8lhd0-zip-3.0/bin/zip" ] && echo "/nix/store/chqyzmw0g42i2v9r4lf38azn73w8lhd0-zip-3.0/bin/zip" || find /nix/store -maxdepth 4 -name "zip" -type f -executable 2>/dev/null | grep -E '/bin/zip$' | head -n 1 || true)"

if [ -z "$CLANG" ]; then
  echo "❌ clang compiler not found."
  exit 1
fi

if [ -z "$LD64" ]; then
  echo "❌ ld64.lld linker not found."
  exit 1
fi

if [ -z "$ZIP" ]; then
  echo "❌ zip utility not found."
  exit 1
fi

echo "  ✓ CLANG:    $CLANG"
echo "  ✓ LD64.LLD: $LD64"
echo "  ✓ ZIP:      $ZIP"

# 2. Prepare build workspace
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/src" "$BUILD_DIR/Payload/Recro.app"

# 3. Write native iOS launcher source (Objective-C runtime based)
cat << 'EOF' > "$BUILD_DIR/src/main.c"
/*
 * Recro iOS Native Wrapper
 * Native container for Recro with Background Audio and WebKit rendering.
 */
typedef void *id;
typedef void *SEL;
typedef void *Class;
typedef signed char BOOL;
#define YES ((BOOL)1)
#define NO ((BOOL)0)

typedef struct {
    double x;
    double y;
} CGPoint;

typedef struct {
    double width;
    double height;
} CGSize;

typedef struct {
    CGPoint origin;
    CGSize size;
} CGRect;

extern Class objc_allocateClassPair(Class superclass, const char *name, unsigned long extraBytes);
extern void objc_registerClassPair(Class cls);
extern BOOL class_addMethod(Class cls, SEL name, void (*imp)(void), const char *types);
extern Class objc_getClass(const char *name);
extern SEL sel_registerName(const char *name);
extern id objc_msgSend(id self, SEL op, ...);

extern int UIApplicationMain(int argc, char *argv[], void *principalClassName, void *delegateClassName);

static BOOL didFinishLaunching(id self, SEL _cmd, id application, id launchOptions) {
    Class UIScreen = objc_getClass("UIScreen");
    id mainScreen = ((id (*)(id, SEL))objc_msgSend)(UIScreen, sel_registerName("mainScreen"));
    CGRect bounds = ((CGRect (*)(id, SEL))objc_msgSend)(mainScreen, sel_registerName("bounds"));

    Class UIWindow = objc_getClass("UIWindow");
    id window = ((id (*)(id, SEL))objc_msgSend)(UIWindow, sel_registerName("alloc"));
    window = ((id (*)(id, SEL, CGRect))objc_msgSend)(window, sel_registerName("initWithFrame:"), bounds);

    Class UIViewController = objc_getClass("UIViewController");
    id vc = ((id (*)(id, SEL))objc_msgSend)(((id (*)(id, SEL))objc_msgSend)(UIViewController, sel_registerName("alloc")), sel_registerName("init"));

    Class WKWebViewConfiguration = objc_getClass("WKWebViewConfiguration");
    id config = ((id (*)(id, SEL))objc_msgSend)(((id (*)(id, SEL))objc_msgSend)(WKWebViewConfiguration, sel_registerName("alloc")), sel_registerName("init"));
    ((void (*)(id, SEL, BOOL))objc_msgSend)(config, sel_registerName("setAllowsInlineMediaPlayback:"), YES);
    ((void (*)(id, SEL, unsigned long long))objc_msgSend)(config, sel_registerName("setMediaTypesRequiringUserActionForPlayback:"), 0);

    Class WKWebView = objc_getClass("WKWebView");
    id webView = ((id (*)(id, SEL))objc_msgSend)(WKWebView, sel_registerName("alloc"));
    webView = ((id (*)(id, SEL, CGRect, id))objc_msgSend)(webView, sel_registerName("initWithFrame:configuration:"), bounds, config);

    // UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight = 18
    ((void (*)(id, SEL, unsigned long))objc_msgSend)(webView, sel_registerName("setAutoresizingMask:"), 18);

    Class NSURL = objc_getClass("NSURL");
    Class NSString = objc_getClass("NSString");
    id urlStr = ((id (*)(id, SEL, const char *))objc_msgSend)(NSString, sel_registerName("stringWithUTF8String:"), "https://recro.onrender.com/");
    id url = ((id (*)(id, SEL, id))objc_msgSend)(NSURL, sel_registerName("URLWithString:"), urlStr);

    Class NSURLRequest = objc_getClass("NSURLRequest");
    id req = ((id (*)(id, SEL, id))objc_msgSend)(NSURLRequest, sel_registerName("requestWithURL:"), url);
    ((id (*)(id, SEL, id))objc_msgSend)(webView, sel_registerName("loadRequest:"), req);

    id vcView = ((id (*)(id, SEL))objc_msgSend)(vc, sel_registerName("view"));
    ((void (*)(id, SEL, id))objc_msgSend)(vcView, sel_registerName("addSubview:"), webView);

    ((void (*)(id, SEL, id))objc_msgSend)(window, sel_registerName("setRootViewController:"), vc);
    ((void (*)(id, SEL))objc_msgSend)(window, sel_registerName("makeKeyAndVisible"));

    // Activate AVAudioSession for seamless background audio streaming
    Class AVAudioSession = objc_getClass("AVAudioSession");
    if (AVAudioSession) {
        id sharedSession = ((id (*)(id, SEL))objc_msgSend)(AVAudioSession, sel_registerName("sharedInstance"));
        id category = ((id (*)(id, SEL, const char *))objc_msgSend)(NSString, sel_registerName("stringWithUTF8String:"), "AVAudioSessionCategoryPlayback");
        ((BOOL (*)(id, SEL, id, id *))objc_msgSend)(sharedSession, sel_registerName("setCategory:error:"), category, 0);
        ((BOOL (*)(id, SEL, BOOL, id *))objc_msgSend)(sharedSession, sel_registerName("setActive:error:"), YES, 0);
    }

    return YES;
}

int main(int argc, char *argv[]) {
    Class UIResponder = objc_getClass("UIResponder");
    Class appDelegateClass = objc_allocateClassPair(UIResponder, "RecroAppDelegate", 0);
    class_addMethod(appDelegateClass, sel_registerName("application:didFinishLaunchingWithOptions:"), (void (*)(void))didFinishLaunching, "c@:@@");
    objc_registerClassPair(appDelegateClass);

    Class NSString = objc_getClass("NSString");
    id delegateName = ((id (*)(id, SEL, const char *))objc_msgSend)(NSString, sel_registerName("stringWithUTF8String:"), "RecroAppDelegate");

    return UIApplicationMain(argc, argv, 0, delegateName);
}
EOF

# 4. Compile Mach-O 64-bit ARM64 iOS Binary
echo "🔨 Compiling native ARM64 iOS executable..."
"$CLANG" -target arm64-apple-ios14.0 -O2 -c "$BUILD_DIR/src/main.c" -o "$BUILD_DIR/src/main.o"
"$LD64" -arch arm64 -platform_version ios 14.0 14.0 -o "$BUILD_DIR/Payload/Recro.app/Recro" "$BUILD_DIR/src/main.o" -undefined dynamic_lookup
chmod +x "$BUILD_DIR/Payload/Recro.app/Recro"

# 5. Write Info.plist
cat << 'EOF' > "$BUILD_DIR/Payload/Recro.app/Info.plist"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>ru</string>
	<key>CFBundleDisplayName</key>
	<string>Recro</string>
	<key>CFBundleExecutable</key>
	<string>Recro</string>
	<key>CFBundleIdentifier</key>
	<string>com.recro.player</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>Recro</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSRequiresIPhoneOS</key>
	<true/>
	<key>MinimumOSVersion</key>
	<string>14.0</string>
	<key>UIDeviceFamily</key>
	<array>
		<integer>1</integer>
		<integer>2</integer>
	</array>
	<key>UIRequiredDeviceCapabilities</key>
	<array>
		<string>arm64</string>
	</array>
	<key>UIBackgroundModes</key>
	<array>
		<string>audio</string>
	</array>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
		<string>UIInterfaceOrientationPortraitUpsideDown</string>
		<string>UIInterfaceOrientationLandscapeLeft</string>
		<string>UIInterfaceOrientationLandscapeRight</string>
	</array>
	<key>UIStatusBarStyle</key>
	<string>UIStatusBarStyleLightContent</string>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<false/>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
	<key>CFBundleIcons</key>
	<dict>
		<key>CFBundlePrimaryIcon</key>
		<dict>
			<key>CFBundleIconFiles</key>
			<array>
				<string>AppIcon60x60</string>
			</array>
			<key>CFBundleIconName</key>
			<string>AppIcon</string>
		</dict>
	</dict>
</dict>
</plist>
EOF

# 6. Write PkgInfo
printf "APPL????" > "$BUILD_DIR/Payload/Recro.app/PkgInfo"

# 7. Copy App Icons
if [ -f "$FRONTEND_DIR/public/icons/apple-touch-icon.png" ]; then
  cp "$FRONTEND_DIR/public/icons/apple-touch-icon.png" "$BUILD_DIR/Payload/Recro.app/AppIcon60x60@2x.png"
  cp "$FRONTEND_DIR/public/icons/apple-touch-icon.png" "$BUILD_DIR/Payload/Recro.app/AppIcon60x60@3x.png"
  cp "$FRONTEND_DIR/public/icons/apple-touch-icon.png" "$BUILD_DIR/Payload/Recro.app/AppIcon76x76@2x~ipad.png"
  cp "$FRONTEND_DIR/public/icons/icon-512.png" "$BUILD_DIR/Payload/Recro.app/iTunesArtwork.png"
fi

# 8. Package into .ipa (zip archive)
echo "📦 Packaging Recro.ipa..."
cd "$BUILD_DIR"
"$ZIP" -qr9 "$BUILD_DIR/recro.ipa" Payload/

# 9. Output to frontend/public/recro.ipa and dist directories
cp "$BUILD_DIR/recro.ipa" "$FRONTEND_DIR/public/recro.ipa"
if [ -d "$ROOT_DIR/dist_frontend" ]; then
  cp "$BUILD_DIR/recro.ipa" "$ROOT_DIR/dist_frontend/recro.ipa"
fi
if [ -d "$FRONTEND_DIR/dist/browser" ]; then
  cp "$BUILD_DIR/recro.ipa" "$FRONTEND_DIR/dist/browser/recro.ipa"
fi
if [ -d "$FRONTEND_DIR/dist/frontend/browser" ]; then
  cp "$BUILD_DIR/recro.ipa" "$FRONTEND_DIR/dist/frontend/browser/recro.ipa"
fi

IPA_SIZE="$(du -h "$FRONTEND_DIR/public/recro.ipa" | cut -f1)"

echo "══════════════════════════════════════════════════════"
echo "  ✅ SUCCESS! Recro.ipa generated:"
echo "     frontend/public/recro.ipa ($IPA_SIZE)"
echo "     Compatible with: ESign, Scarlet, AltStore, SideStore, Gbox, TrollStore"
echo "══════════════════════════════════════════════════════"
