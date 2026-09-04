import QRCode from "qrcode";
import jsQR from "jsqr";
import {
  compressToEncodedURIComponent,
  decompressFromEncodedURIComponent,
} from "lz-string";

/** Render a compressed payload as a QR code canvas inside the given container. */
export async function renderQr(
  container: HTMLElement,
  payload: string,
): Promise<void> {
  container.innerHTML = "";
  const canvas = document.createElement("canvas");
  const compressed = compressToEncodedURIComponent(payload);
  await QRCode.toCanvas(canvas, compressed, {
    errorCorrectionLevel: "L", // payload is dense; low error correction keeps modules bigger/scannable
    margin: 1,
    width: 280,
  });
  container.appendChild(canvas);
}

export type ScanHandle = { stop: () => void };

/**
 * Start scanning a live camera feed rendered into the given <video> element.
 * Calls onResult once with the decoded (decompressed) payload, then stops itself.
 */
export async function startScanning(
  video: HTMLVideoElement,
  onResult: (payload: string) => void,
  onError: (err: unknown) => void,
): Promise<ScanHandle> {
  let stopped = false;
  let stream: MediaStream | null = null;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false,
    });
  } catch (err) {
    onError(err);
    return { stop: () => {} };
  }

  video.srcObject = stream;
  await video.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

  function tick() {
    if (stopped) return;
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code) {
        const payload = decompressFromEncodedURIComponent(code.data);
        if (payload) {
          stop();
          onResult(payload);
          return;
        }
      }
    }
    requestAnimationFrame(tick);
  }

  function stop() {
    stopped = true;
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }

  requestAnimationFrame(tick);
  return { stop };
}
