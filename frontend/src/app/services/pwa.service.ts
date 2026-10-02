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

  // Computes whether install button should be visible (e.g. mobile and not already running in standalone)
  readonly shouldShowInstallButton = computed(() => {
    return this.isMobile() && !this.isStandalone() && !this.isInstalled();
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

    const isMobileCheck = isIosDevice || /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua) || window.innerWidth <= 768;
    this.isMobile.set(isMobileCheck);

    const isNativeApp =
      /RecroApp/i.test(ua) ||
      (typeof window !== 'undefined' && (
        typeof (window as any).AndroidMediaBridge !== 'undefined' ||
        typeof (window as any).recroMediaAction !== 'undefined'
      ));

    const isAndroidWebView =
      /wv/i.test(ua) ||
      (/Version\/[0-9.]+\s+Chrome\/[0-9.]+/i.test(ua) && !/Mobile Safari/i.test(ua));

    const isReferrerApp =
      typeof document !== 'undefined' && !!document.referrer && document.referrer.startsWith('android-app://');

    let isStoredInstalled = false;
    try {
      isStoredInstalled =
        typeof localStorage !== 'undefined' &&
        (localStorage.getItem('recro_pwa_installed') === 'true' || localStorage.getItem('recro_installed') === 'true');
    } catch {}

    const isStandaloneMode =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches ||
      (navigator as any).standalone === true ||
      isNativeApp ||
      isAndroidWebView ||
      isReferrerApp;

    this.isStandalone.set(isStandaloneMode);
    if (isStandaloneMode || isStoredInstalled) {
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
      const mobileNow = this.isIos() || /Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
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

  openInstallModal() {
    this.isInstallModalOpen.set(true);
  }

  closeInstallModal() {
    this.isInstallModalOpen.set(false);
  }
}
