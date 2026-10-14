import { Injectable, signal, computed } from '@angular/core';

export type InstallOutcome = 'accepted' | 'dismissed' | 'manual' | 'already-installed';

@Injectable({
  providedIn: 'root'
})
export class PwaService {
  private deferredPrompt: any = null;

  readonly isMobile = signal<boolean>(false);
  readonly isIos = signal<boolean>(false);
  readonly isInAppBrowser = signal<boolean>(false);
  readonly isStandalone = signal<boolean>(false);
  readonly isInstalled = signal<boolean>(false);
  readonly canPromptInstall = signal<boolean>(false);
  readonly isInstallModalOpen = signal<boolean>(false);
  readonly activeInstallTab = signal<'android' | 'ios'>('android');

  readonly shouldShowInstallButton = computed(() => {
    return this.isMobile() && !this.isStandalone();
  });

  constructor() {
    this.initPlatformDetection();
    this.initInstallPromptListener();
  }

  private initPlatformDetection() {
    if (typeof window === 'undefined') return;

    const ua = navigator.userAgent || '';

    const isIosDevice = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    this.isIos.set(isIosDevice);

    const isInApp = /Telegram|VKApp|Instagram|FBAN|FBAV|Line|WeChat/i.test(ua);
    this.isInAppBrowser.set(isInApp);

    // Only actual phones/mobile devices (iOS, Android, etc.) - never desktop/PC
    const isMobileCheck = isIosDevice || /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    this.isMobile.set(isMobileCheck);

    const isNativeApp =
      /RecroApp/i.test(ua) ||
      (typeof window !== 'undefined' && (
        typeof (window as any).AndroidMediaBridge !== 'undefined' ||
        typeof (window as any).recroMediaAction !== 'undefined'
      ));

    // Only real standalone PWA mode (not browser scroll fullscreen)
    const isStandaloneMode =
      (typeof window !== 'undefined' && window.matchMedia('(display-mode: standalone)').matches) ||
      (typeof navigator !== 'undefined' && (navigator as any).standalone === true) ||
      isNativeApp;

    this.isStandalone.set(isStandaloneMode);
    if (isStandaloneMode) {
      this.isInstalled.set(true);
    }

    try {
      window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
        this.isStandalone.set(e.matches);
        if (e.matches) {
          this.isInstalled.set(true);
          this.canPromptInstall.set(false);
          this.deferredPrompt = null;
        }
      });
    } catch {}

    window.addEventListener('resize', () => {
      const uaNow = navigator.userAgent || '';
      const mobileNow = /iPhone|iPad|iPod/i.test(uaNow) || /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(uaNow) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      this.isMobile.set(mobileNow);
    });
  }

  private initInstallPromptListener() {
    if (typeof window === 'undefined') return;

    // 1. Check if early script in index.html already captured beforeinstallprompt
    const earlyPrompt = (window as any).__pwaDeferredPrompt;
    if (earlyPrompt) {
      this.deferredPrompt = earlyPrompt;
      this.canPromptInstall.set(true);
    }

    // 2. Listen to custom event dispatched by early script when prompt arrives
    window.addEventListener('pwa-prompt-available', (event: any) => {
      this.deferredPrompt = event.detail || (window as any).__pwaDeferredPrompt;
      this.canPromptInstall.set(true);
    });

    // 3. Native listener in case prompt fires after service initializes
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      e.preventDefault();
      this.deferredPrompt = e;
      (window as any).__pwaDeferredPrompt = e;
      this.canPromptInstall.set(true);
    });

    const onInstalled = () => {
      this.deferredPrompt = null;
      (window as any).__pwaDeferredPrompt = null;
      this.canPromptInstall.set(false);
      this.isInstalled.set(true);
      this.isInstallModalOpen.set(false);
      try {
        localStorage.setItem('recro_pwa_installed', 'true');
        localStorage.setItem('recro_installed', 'true');
      } catch {}
    };

    // 4. Handle successful installation
    window.addEventListener('appinstalled', onInstalled);
    window.addEventListener('pwa-installed', onInstalled);
  }

  async promptInstall(): Promise<InstallOutcome> {
    if (this.isStandalone() || this.isInstalled()) {
      return 'already-installed';
    }

    // If native prompt is available (Android Chrome, Edge, Chromium)
    if (this.deferredPrompt) {
      try {
        const promptEvent = this.deferredPrompt;
        this.deferredPrompt = null;
        (window as any).__pwaDeferredPrompt = null;
        this.canPromptInstall.set(false);

        await promptEvent.prompt();
        const choice = await promptEvent.userChoice;

        if (choice && choice.outcome === 'accepted') {
          this.isInstalled.set(true);
          this.closeInstallModal();
          return 'accepted';
        }
        // If user dismissed the native prompt, open the manual guide so they know where to find it
        this.openInstallModal();
        return 'dismissed';
      } catch (err) {
        console.warn('[PWA] Prompt call failed, falling back to manual instructions:', err);
      }
    }

    // Fallback: Show manual installation instructions dialog (iOS Safari, or browsers without prompt API)
    this.openInstallModal();
    return 'manual';
  }

  openInstallModal(platform?: 'android' | 'ios') {
    if (platform) {
      this.activeInstallTab.set(platform);
    } else {
      this.activeInstallTab.set(this.isIos() ? 'ios' : 'android');
    }
    this.isInstallModalOpen.set(true);
  }

  closeInstallModal() {
    this.isInstallModalOpen.set(false);
  }
}
