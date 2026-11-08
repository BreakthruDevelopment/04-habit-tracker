import { AiError, type AiImage } from "./types";

export const MAX_IMAGES = 4;
/** Decoded size cap per image. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Decoded size cap across all images (Gemini's inline limit is 20 MB per request including text). */
export const MAX_TOTAL_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;

// Strict standard base64: no whitespace, no data: prefix; length and padding are checked separately
// (a grouped regex overflows the stack on multi-MB strings).
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function decodedBytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

/** Throws input_rejected before any network call. Returns the total decoded bytes. Never echoes image data. */
export function validateImages(images: AiImage[] | undefined): { count: number; bytes: number } {
  if (!images || images.length === 0) return { count: 0, bytes: 0 };
  if (images.length > MAX_IMAGES) throw new AiError(`At most ${MAX_IMAGES} images per request`, "input_rejected");
  let total = 0;
  for (const img of images) {
    if (!(IMAGE_MIME_TYPES as readonly string[]).includes(img.mimeType)) {
      throw new AiError("Unsupported image type", "input_rejected");
    }
    if (typeof img.data !== "string" || img.data.length === 0 || img.data.length % 4 !== 0 || !BASE64.test(img.data)) {
      throw new AiError("Image data is not valid base64", "input_rejected");
    }
    const bytes = decodedBytes(img.data);
    if (bytes > MAX_IMAGE_BYTES) {
      throw new AiError(`An image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, "input_rejected");
    }
    total += bytes;
  }
  if (total > MAX_TOTAL_IMAGE_BYTES) {
    throw new AiError(`Images total more than ${MAX_TOTAL_IMAGE_BYTES / 1024 / 1024} MB`, "input_rejected");
  }
  return { count: images.length, bytes: total };
}
