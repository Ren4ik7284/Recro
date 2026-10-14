// @vitest-environment jsdom
import '@angular/compiler';
import { describe, it, expect } from 'vitest';
import { ProfileComponent } from './profile.component';

describe('ProfileComponent Artist Color Hash to HEX', () => {
  // Проверяем логику генерации цветов
  const getArtistColor = ProfileComponent.prototype.getArtistColor;
  const getArtistGlow = ProfileComponent.prototype.getArtistGlow;
  const getArtistBorder = ProfileComponent.prototype.getArtistBorder;
  const hslToHex = (ProfileComponent.prototype as any).hslToHex;

  it('should generate a valid 6-digit hex color (#RRGGBB)', () => {
    const context: any = {
      artistColorCache: new Map<string, string>(),
      hslToHex,
    };
    const color = getArtistColor.call(context, 'The Weeknd');
    expect(color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('should be deterministic for the same artist name', () => {
    const context: any = {
      artistColorCache: new Map<string, string>(),
      hslToHex,
    };
    const color1 = getArtistColor.call(context, 'Taylor Swift');
    const color2 = getArtistColor.call(context, 'Taylor Swift');
    expect(color1).toBe(color2);
  });

  it('should normalize artist names (case-insensitive and trimmed)', () => {
    const context: any = {
      artistColorCache: new Map<string, string>(),
      hslToHex,
    };
    const color1 = getArtistColor.call(context, '  Linkin Park  ');
    const color2 = getArtistColor.call(context, 'linkin park');
    expect(color1).toBe(color2);
  });

  it('should generate different colors for different artists', () => {
    const context: any = {
      artistColorCache: new Map<string, string>(),
      hslToHex,
    };
    const color1 = getArtistColor.call(context, 'Кино');
    const color2 = getArtistColor.call(context, 'Король и Шут');
    const color3 = getArtistColor.call(context, 'Eminem');

    expect(color1).not.toBe(color2);
    expect(color1).not.toBe(color3);
    expect(color2).not.toBe(color3);
  });

  it('should return valid rgba glow and border strings', () => {
    const context: any = {
      artistColorCache: new Map<string, string>(),
      hslToHex,
      getArtistColor: (name: string) => getArtistColor.call(context, name),
    };
    const glow = getArtistGlow.call(context, 'Drake');
    const border = getArtistBorder.call(context, 'Drake');

    expect(glow).toMatch(/^rgba\(\d{1,3},\s*\d{1,3},\s*\d{1,3},\s*0\.38\)$/);
    expect(border).toMatch(/^rgba\(\d{1,3},\s*\d{1,3},\s*\d{1,3},\s*0\.65\)$/);
  });

  it('should fallback gracefully on empty artist names', () => {
    const context: any = {
      artistColorCache: new Map<string, string>(),
      hslToHex,
    };
    expect(getArtistColor.call(context, '')).toBe('#1ed760');
  });
});
