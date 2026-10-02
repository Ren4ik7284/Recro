// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { PwaService } from './pwa.service';

describe('PwaService', () => {
  let service: PwaService;

  beforeEach(() => {
    try { localStorage.clear(); } catch {}
    delete (window as any).__pwaDeferredPrompt;
    delete (window as any).AndroidMediaBridge;
    delete (window as any).recroMediaAction;
    if (!window.matchMedia) {
      window.matchMedia = () => ({
        matches: false,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      } as any);
    }
    service = new PwaService();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should capture beforeinstallprompt and set canPromptInstall to true', () => {
    const mockPromptEvent = {
      preventDefault: () => {},
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: 'accepted' })
    };

    window.dispatchEvent(new CustomEvent('pwa-prompt-available', { detail: mockPromptEvent }));
    expect(service.canPromptInstall()).toBe(true);
  });

  it('should prompt install natively when deferredPrompt is available', async () => {
    let promptCalled = false;
    const mockPromptEvent = {
      preventDefault: () => {},
      prompt: async () => {
        promptCalled = true;
      },
      userChoice: Promise.resolve({ outcome: 'accepted' })
    };

    window.dispatchEvent(new CustomEvent('pwa-prompt-available', { detail: mockPromptEvent }));
    expect(service.canPromptInstall()).toBe(true);

    const outcome = await service.promptInstall();
    expect(promptCalled).toBe(true);
    expect(outcome).toBe('accepted');
    expect(service.isInstalled()).toBe(true);
    expect(service.canPromptInstall()).toBe(false);
  });

  it('should open install modal when deferredPrompt is not available (manual fallback)', async () => {
    expect(service.canPromptInstall()).toBe(false);
    expect(service.isInstallModalOpen()).toBe(false);

    const outcome = await service.promptInstall();
    expect(outcome).toBe('manual');
    expect(service.isInstallModalOpen()).toBe(true);
  });

  it('should mark as installed when appinstalled event fires', () => {
    window.dispatchEvent(new Event('appinstalled'));
    expect(service.isInstalled()).toBe(true);
    expect(service.canPromptInstall()).toBe(false);
    expect(service.isInstallModalOpen()).toBe(false);
  });

  it('should detect Recro native app bridge and mark as standalone/installed', () => {
    (window as any).AndroidMediaBridge = { updateMediaSession: () => {} };
    const nativeService = new PwaService();
    expect(nativeService.isStandalone()).toBe(true);
    expect(nativeService.isInstalled()).toBe(true);
    expect(nativeService.shouldShowInstallButton()).toBe(false);
  });

  it('should return already-installed if promptInstall is called when installed', async () => {
    window.dispatchEvent(new Event('appinstalled'));
    const outcome = await service.promptInstall();
    expect(outcome).toBe('already-installed');
  });
});
