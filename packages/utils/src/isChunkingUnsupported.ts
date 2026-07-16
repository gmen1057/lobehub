import { isSvgMime } from './isVisionImage';

export const isChunkingUnsupported = (fileType: string): boolean => {
  // SVG is text/XML — parse into documents.content and inject as code, not vision.
  if (isSvgMime(fileType)) return false;
  if (fileType.startsWith('image')) return true;
  if (fileType.startsWith('video')) return true;
  if (fileType.startsWith('audio')) return true;
  return false; // false doesn't mean supported, it means we don't know
};
