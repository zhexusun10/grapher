/**
 * Client-side raster image resizing/compression for inline Pi RPC vision images.
 *
 * Keeps ordinary images untouched while automatically downscaling oversized
 * screenshots/photos (for example 5K Retina PNGs) to stay well within both
 * Grapher's JSON request limit and upstream vision API budgets (e.g. 5 MB).
 */

export const MAX_VISION_IMAGE_DIMENSION = 2000;
/** ~4.3 MiB of base64 payload (~3.2 MiB raw), below Anthropic's 5 MB limit. */
export const MAX_VISION_IMAGE_BASE64_BYTES = 4_500_000;

export interface PreparedVisionImage {
  mimeType: string;
  data: string;
}

export interface VisionImageResizeOptions {
  maxWidth?: number;
  maxHeight?: number;
  maxBase64Bytes?: number;
}

export function extractBase64FromDataUrl(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(",");
  return commaIndex !== -1 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

export function computeScaledDimensions(
  width: number,
  height: number,
  maxWidth = MAX_VISION_IMAGE_DIMENSION,
  maxHeight = MAX_VISION_IMAGE_DIMENSION,
): { width: number; height: number; scaled: boolean } {
  if (width <= 0 || height <= 0) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), scaled: false };
  }
  const ratio = Math.min(1, maxWidth / width, maxHeight / height);
  if (ratio >= 1) {
    return { width: Math.round(width), height: Math.round(height), scaled: false };
  }
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image"));
    img.src = src;
  });
}

function encodeExistingCanvas(
  canvas: HTMLCanvasElement,
  mimeType: string,
  quality?: number,
): PreparedVisionImage | null {
  const dataUrl = quality !== undefined ? canvas.toDataURL(mimeType, quality) : canvas.toDataURL(mimeType);
  if (!dataUrl || !dataUrl.startsWith(`data:${mimeType}`)) {
    return null;
  }
  const data = extractBase64FromDataUrl(dataUrl);
  return data ? { mimeType, data } : null;
}

function pickSmaller(a: PreparedVisionImage | null, b: PreparedVisionImage | null): PreparedVisionImage | null {
  if (!a) return b;
  if (!b) return a;
  return b.data.length < a.data.length ? b : a;
}

export async function prepareVisionImageAttachment(
  file: File,
  initialMimeType: string,
  existingPreviewUrl?: string | null,
  options?: VisionImageResizeOptions,
): Promise<PreparedVisionImage> {
  const maxWidth = options?.maxWidth ?? MAX_VISION_IMAGE_DIMENSION;
  const maxHeight = options?.maxHeight ?? MAX_VISION_IMAGE_DIMENSION;
  const maxBase64Bytes = options?.maxBase64Bytes ?? MAX_VISION_IMAGE_BASE64_BYTES;

  const existingDataUrl = existingPreviewUrl?.startsWith("data:") ? existingPreviewUrl : null;
  const existingBlobUrl = existingPreviewUrl?.startsWith("blob:") ? existingPreviewUrl : null;

  let cachedOriginal: PreparedVisionImage | null = existingDataUrl
    ? { mimeType: initialMimeType, data: extractBase64FromDataUrl(existingDataUrl) }
    : null;
  const readOriginal = async (): Promise<PreparedVisionImage> => {
    if (cachedOriginal) return cachedOriginal;
    const dataUrl = await readFileAsDataUrl(file);
    cachedOriginal = { mimeType: initialMimeType, data: extractBase64FromDataUrl(dataUrl) };
    return cachedOriginal;
  };

  // Preserve animated GIFs untouched whenever they already fit the byte budget.
  if (initialMimeType === "image/gif") {
    const estimatedBase64 = cachedOriginal
      ? cachedOriginal.data.length
      : Math.ceil(file.size / 3) * 4;
    if (estimatedBase64 <= maxBase64Bytes) {
      const original = await readOriginal();
      if (original.data.length <= maxBase64Bytes) {
        return original;
      }
    }
  }

  if (typeof Image === "undefined" || typeof document === "undefined") {
    const original = await readOriginal();
    if (original.data.length > maxBase64Bytes) {
      throw new Error("Image exceeds maximum supported size");
    }
    return original;
  }

  let temporaryObjectUrl: string | null = null;
  let img: HTMLImageElement;
  try {
    let imageSrc = existingDataUrl || existingBlobUrl;
    if (!imageSrc) {
      if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
        temporaryObjectUrl = URL.createObjectURL(file);
        imageSrc = temporaryObjectUrl;
      } else {
        const original = await readOriginal();
        imageSrc = `data:${original.mimeType};base64,${original.data}`;
      }
    }
    img = await loadHtmlImage(imageSrc);
  } catch {
    if (temporaryObjectUrl) URL.revokeObjectURL(temporaryObjectUrl);
    const original = await readOriginal();
    if (original.data.length > maxBase64Bytes) {
      throw new Error("Image could not be decoded or compressed within size limit");
    }
    return original;
  }

  try {
    const naturalWidth = img.naturalWidth || img.width;
    const naturalHeight = img.naturalHeight || img.height;
    const initialTarget = computeScaledDimensions(naturalWidth, naturalHeight, maxWidth, maxHeight);
    const estimatedOriginalBase64 = cachedOriginal
      ? cachedOriginal.data.length
      : Math.ceil(file.size / 3) * 4;
    if (!initialTarget.scaled && estimatedOriginalBase64 <= maxBase64Bytes) {
      const original = await readOriginal();
      if (original.data.length <= maxBase64Bytes) {
        return original;
      }
    }

    let best: PreparedVisionImage | null = cachedOriginal;
    const scaleSteps = [1, 0.75, 0.5, 0.35, 0.25, 0.15];
    const jpegQualities = [0.85, 0.75, 0.65, 0.55];

    for (const scale of scaleSteps) {
      const width = Math.max(1, Math.round(initialTarget.width * scale));
      const height = Math.max(1, Math.round(initialTarget.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      try {
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        const trySameFormat = scale === 1 && (initialMimeType === "image/png" || initialMimeType === "image/webp");
        if (trySameFormat) {
          ctx.drawImage(img, 0, 0, width, height);
          const sameFormat = encodeExistingCanvas(
            canvas,
            initialMimeType,
            initialMimeType === "image/webp" ? 0.85 : undefined,
          );
          best = pickSmaller(best, sameFormat);
          if (sameFormat && sameFormat.data.length <= maxBase64Bytes) {
            return sameFormat;
          }
          // Paint white behind any transparent pixels before JPEG encoding,
          // reusing the already-resampled canvas without redrawing `img`.
          ctx.globalCompositeOperation = "destination-over";
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, width, height);
          ctx.globalCompositeOperation = "source-over";
        } else {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
        }

        for (const quality of jpegQualities) {
          const jpeg = encodeExistingCanvas(canvas, "image/jpeg", quality);
          best = pickSmaller(best, jpeg);
          if (jpeg && jpeg.data.length <= maxBase64Bytes) {
            return jpeg;
          }
        }
      } finally {
        // Release GPU backing store promptly on WebKit/WKWebView.
        canvas.width = 0;
        canvas.height = 0;
      }
    }

    if (best && best.data.length <= maxBase64Bytes) {
      return best;
    }
    throw new Error("Image exceeds maximum supported size after compression");
  } finally {
    if (temporaryObjectUrl) URL.revokeObjectURL(temporaryObjectUrl);
  }
}
