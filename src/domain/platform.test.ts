import { describe, expect, it } from 'vitest';
import { detectPlatformCapabilities, detectPlatformKind, manualInstallInstructions, platformLabel } from './platform';

describe('cross-platform detection', () => {
  it('detects the four supported operating-system families', () => {
    expect(detectPlatformKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32')).toBe('windows');
    expect(detectPlatformKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6)', 'MacIntel')).toBe('macos');
    expect(detectPlatformKind('Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'Linux armv8l', 5)).toBe('android');
    expect(detectPlatformKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 'iPhone', 5)).toBe('ios');
  });

  it('recognizes iPadOS desktop-class user agents by touch capability', () => {
    expect(detectPlatformKind('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 5)).toBe('ios');
    expect(detectPlatformKind('Mozilla/5.0 (Macintosh; Intel Mac OS X)', 'MacIntel', 0)).toBe('macos');
  });

  it('provides device-specific install guidance', () => {
    expect(platformLabel('ios')).toBe('iPhone / iPad');
    expect(manualInstallInstructions('ios')).toContain('添加到主屏幕');
    expect(manualInstallInstructions('windows')).toContain('Edge/Chrome');
  });

  it('only advertises file sharing when the browser accepts File payloads', () => {
    Object.defineProperty(navigator, 'share', { value: () => Promise.resolve(), configurable: true });
    Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
    expect(detectPlatformCapabilities().fileShare).toBe(false);

    Object.defineProperty(navigator, 'canShare', {
      value: (data: ShareData) => Boolean(data.files?.length),
      configurable: true,
    });
    expect(detectPlatformCapabilities().fileShare).toBe(true);
  });
});
