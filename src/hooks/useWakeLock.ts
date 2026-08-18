import { useCallback, useEffect, useRef, useState } from 'react';

type WakeLockStatus = 'inactive' | 'active' | 'unsupported' | 'blocked';

export function useWakeLock(enabled: boolean) {
  const supported = 'wakeLock' in navigator;
  const [status, setStatus] = useState<WakeLockStatus>(supported ? 'inactive' : 'unsupported');
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        // The browser may have released it already while hiding the page.
      }
    }
    setStatus(supported ? 'inactive' : 'unsupported');
  }, [supported]);

  const request = useCallback(async () => {
    if (!enabled || !supported || document.visibilityState !== 'visible') return;
    if (sentinelRef.current && !sentinelRef.current.released) return;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinelRef.current = sentinel;
      setStatus('active');
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) sentinelRef.current = null;
        setStatus(enabled ? 'blocked' : 'inactive');
      }, { once: true });
    } catch {
      setStatus('blocked');
    }
  }, [enabled, supported]);

  useEffect(() => {
    if (!enabled) {
      void release();
      return;
    }
    void request();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void request();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      void release();
    };
  }, [enabled, release, request]);

  return { status, supported };
}
