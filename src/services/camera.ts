export function cameraConstraintCandidates(deviceId?: string): MediaStreamConstraints[] {
  const preferred: MediaTrackConstraints = {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  };
  const candidates: MediaStreamConstraints[] = [];
  if (deviceId) {
    candidates.push({
      video: { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  }
  candidates.push({ video: preferred, audio: false });
  candidates.push({ video: true, audio: false });
  return candidates;
}

function canRetryCameraError(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : (error as { name?: string } | null)?.name;
  return name === 'OverconstrainedError' || name === 'NotFoundError';
}

export async function requestCameraStream(
  mediaDevices: Pick<MediaDevices, 'getUserMedia'>,
  deviceId?: string,
): Promise<MediaStream> {
  const candidates = cameraConstraintCandidates(deviceId);
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const stream = await mediaDevices.getUserMedia(candidates[index]);
      if (stream.getVideoTracks().length === 0) {
        stream.getTracks().forEach((track) => track.stop());
        throw new DOMException('没有可用的视频轨道', 'NotFoundError');
      }
      return stream;
    } catch (error) {
      lastError = error;
      if (!canRetryCameraError(error) || index === candidates.length - 1) throw error;
    }
  }
  throw lastError;
}
