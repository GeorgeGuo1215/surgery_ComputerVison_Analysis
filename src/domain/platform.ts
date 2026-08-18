export type PlatformKind = 'windows' | 'macos' | 'android' | 'ios' | 'other';

export interface PlatformCapabilities {
  kind: PlatformKind;
  label: string;
  mobile: boolean;
  standalone: boolean;
  secureContext: boolean;
  camera: boolean;
  serviceWorker: boolean;
  speech: boolean;
  wakeLock: boolean;
  fileShare: boolean;
  mp4Playback: boolean;
  quickTimePlayback: boolean;
}

export function detectPlatformKind(
  userAgent: string,
  navigatorPlatform = '',
  maxTouchPoints = 0,
): PlatformKind {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (/mac/i.test(navigatorPlatform) && maxTouchPoints > 1) return 'ios';
  if (/windows/i.test(userAgent) || /win/i.test(navigatorPlatform)) return 'windows';
  if (/macintosh|mac os x/i.test(userAgent) || /mac/i.test(navigatorPlatform)) return 'macos';
  return 'other';
}

export function platformLabel(kind: PlatformKind): string {
  return {
    windows: 'Windows',
    macos: 'macOS',
    android: 'Android',
    ios: 'iPhone / iPad',
    other: '当前设备',
  }[kind];
}

export function isStandaloneDisplay(): boolean {
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches === true || navigatorWithStandalone.standalone === true;
}

export function detectPlatformCapabilities(): PlatformCapabilities {
  const kind = detectPlatformKind(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
  const probe = document.createElement('video');
  const navigatorWithShare = navigator as Navigator & {
    canShare?: (data?: ShareData) => boolean;
    wakeLock?: unknown;
  };
  let fileShare = false;
  try {
    fileShare =
      typeof navigator.share === 'function' &&
      typeof navigatorWithShare.canShare === 'function' &&
      navigatorWithShare.canShare({ files: [new File([''], 'petor-test.txt', { type: 'text/plain' })] });
  } catch {
    fileShare = false;
  }
  return {
    kind,
    label: platformLabel(kind),
    mobile: kind === 'android' || kind === 'ios',
    standalone: isStandaloneDisplay(),
    secureContext: window.isSecureContext,
    camera: Boolean(navigator.mediaDevices?.getUserMedia),
    serviceWorker: 'serviceWorker' in navigator,
    speech: 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
    wakeLock: 'wakeLock' in navigatorWithShare,
    fileShare,
    mp4Playback: probe.canPlayType('video/mp4; codecs="avc1.42E01E"') !== '',
    quickTimePlayback: probe.canPlayType('video/quicktime') !== '',
  };
}

export function manualInstallInstructions(kind: PlatformKind): string {
  if (kind === 'ios') return '请在 Safari 中点“分享”，再选择“添加到主屏幕”。建议安装后再新建病例，Safari 中已有草稿可能不会自动带入。';
  if (kind === 'macos') return 'Safari 可用“文件 → 添加到程序坞”；Chrome 可用地址栏安装图标。建议安装后再新建病例。';
  if (kind === 'android') return '请打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。';
  if (kind === 'windows') return '请使用 Edge/Chrome 地址栏的安装图标，或浏览器菜单中的“安装应用”。';
  return '请使用浏览器菜单中的“安装应用”或“添加到主屏幕”。';
}
