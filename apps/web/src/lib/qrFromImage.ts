/**
 * Reads a QR code out of a picture, so a connect screen that shows only a QR (no "copy" button) can still be linked:
 * take a screenshot, paste or upload it, and the code inside is read here, in the browser. The picture is never sent
 * anywhere; only the code that comes out of it is used.
 */
import jsQR from "jsqr";

/** Decodes raw RGBA pixels. Pure, so it can be tested without a browser. Returns the QR's text, or null. */
export function decodeQrFromPixels(data: Uint8ClampedArray, width: number, height: number): string | null {
  // "attemptBoth" also tries the inverted image, because many apps draw a light code on a dark background.
  return jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/**
 * A screenshot is usually much larger than the code in it, and a very large image is slow to scan. Try the image at
 * a few sizes (full, then smaller) and take the first that reads.
 */
const SCALES = [1, 0.6, 0.35];
const MAX_SIDE = 2400;

/** Decodes the first QR code found in an image file or pasted image. Browser only. */
export async function decodeQrFromImage(image: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(image);
  try {
    const fit = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    for (const scale of SCALES) {
      const width = Math.max(1, Math.round(bitmap.width * fit * scale));
      const height = Math.max(1, Math.round(bitmap.height * fit * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("This browser cannot read pictures.");
      context.drawImage(bitmap, 0, 0, width, height);
      const text = decodeQrFromPixels(context.getImageData(0, 0, width, height).data, width, height);
      if (text) return text;
    }
    return null;
  } finally {
    bitmap.close();
  }
}
