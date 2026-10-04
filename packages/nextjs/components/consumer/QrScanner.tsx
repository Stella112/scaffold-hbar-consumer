"use client";

import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Camera QR scanner (getUserMedia + jsQR). Calls onResult once with the decoded text, then stops the camera.
 * Works on HTTPS or localhost only, as browsers require for camera access.
 */
export function QrScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let done = false;
    const stop = () => {
      done = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach(t => t.stop());
    };
    const tick = () => {
      if (done) return;
      const v = video.current;
      const c = canvas.current;
      if (v && c && v.readyState === v.HAVE_ENOUGH_DATA) {
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (code?.data) {
            stop();
            onResult(code.data);
            return;
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" } })
      .then(s => {
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        frame = requestAnimationFrame(tick);
      })
      .catch(e => setError((e as Error).message || "Camera unavailable"));
    if (!navigator.mediaDevices) setError("Camera not available in this browser");
    return stop;
  }, [onResult]);

  return (
    <div className="flex flex-col gap-2 items-center">
      {error ? (
        <div className="alert alert-warning text-xs">Camera: {error}. Paste the link instead.</div>
      ) : (
        <video ref={video} className="w-full max-w-xs rounded-lg" muted playsInline />
      )}
      <canvas ref={canvas} className="hidden" />
      <button className="btn btn-xs btn-ghost" onClick={onClose}>
        Close camera
      </button>
    </div>
  );
}
