/**
 * Vision APIs (OpenAI / Gemini / Azure) accept raster images only.
 * SVG is text/XML — must not go as multimodal image_url (providers return 400).
 *
 * Chat policy (arckep):
 * - small SVG → inline as source code in the prompt (fileList)
 * - large SVG → offer convert to PNG; if user declines → full SVG source as code
 */

export const SVG_MIME_TYPES = new Set(['image/svg+xml', 'image/svg']);

/** Above this size (bytes) we ask the user to convert SVG → PNG. */
export const SVG_LARGE_THRESHOLD_BYTES = 32 * 1024; // 32 KiB

/** Soft warning when embedding SVG source; still allowed. */
export const SVG_CODE_SOFT_CAP_BYTES = 256 * 1024; // 256 KiB

export const isSvgMime = (fileType: string | null | undefined): boolean => {
  if (!fileType) return false;
  const t = fileType.toLowerCase().trim();
  if (SVG_MIME_TYPES.has(t)) return true;
  // Some browsers / detectors use "image/svg+xml; charset=utf-8"
  if (t.startsWith('image/svg')) return true;
  return false;
};

export const isSvgFileName = (name: string | null | undefined): boolean => {
  if (!name) return false;
  return name.toLowerCase().endsWith('.svg');
};

/** Raster image suitable for vision image_url parts. */
export const isVisionImageMime = (fileType: string | null | undefined): boolean => {
  if (!fileType) return false;
  const t = fileType.toLowerCase().trim();
  if (!t.startsWith('image')) return false;
  return !isSvgMime(t);
};

export const isLargeSvg = (sizeBytes: number): boolean => sizeBytes > SVG_LARGE_THRESHOLD_BYTES;
