import { describe, expect, it, vi } from 'vitest';
import { cameraConstraintCandidates, requestCameraStream } from './camera';

function streamWithVideo(): MediaStream {
  return {
    getVideoTracks: () => [{ stop: vi.fn() } as unknown as MediaStreamTrack],
    getTracks: () => [{ stop: vi.fn() } as unknown as MediaStreamTrack],
  } as unknown as MediaStream;
}

describe('cross-platform camera fallback', () => {
  it('tries an exact device, rear-camera preference and finally any camera', () => {
    const candidates = cameraConstraintCandidates('camera-2');
    expect(candidates).toHaveLength(3);
    expect(candidates[0].video).toMatchObject({ deviceId: { exact: 'camera-2' } });
    expect(candidates[1].video).toMatchObject({ facingMode: { ideal: 'environment' } });
    expect(candidates[2].video).toBe(true);
  });

  it('falls back when a platform rejects camera constraints', async () => {
    const stream = streamWithVideo();
    const getUserMedia = vi.fn()
      .mockRejectedValueOnce(new DOMException('constraint', 'OverconstrainedError'))
      .mockResolvedValueOnce(stream);
    await expect(requestCameraStream({ getUserMedia } as Pick<MediaDevices, 'getUserMedia'>, 'missing')).resolves.toBe(stream);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
  });

  it('does not retry after the user denies permission', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    await expect(requestCameraStream({ getUserMedia } as Pick<MediaDevices, 'getUserMedia'>)).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
