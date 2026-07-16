/**
 * Browser-only: rasterize an SVG File to PNG for vision-model upload.
 */

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode SVG for PNG conversion'));
    img.src = url;
  });

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Canvas toBlob returned null'));
          return;
        }
        resolve(blob);
      },
      type,
      quality,
    );
  });

/**
 * Convert SVG file to PNG. Uses a white background so transparent logos stay visible.
 * @param maxEdge max width/height of the raster output
 */
export async function convertSvgFileToPng(file: File, maxEdge = 1536): Promise<File> {
  const svgText = await file.text();
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const img = await loadImage(objectUrl);
    let width = img.naturalWidth || img.width || 1024;
    let height = img.naturalHeight || img.height || 1024;

    // Some SVGs report 0×0 until drawn — fall back to a sensible square.
    if (!width || !height) {
      width = 1024;
      height = 1024;
    }

    if (width > maxEdge || height > maxEdge) {
      if (width >= height) {
        height = Math.round((maxEdge / width) * height);
        width = maxEdge;
      } else {
        width = Math.round((maxEdge / height) * width);
        height = maxEdge;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const pngBlob = await canvasToBlob(canvas, 'image/png');
    const baseName = file.name.replace(/\.svg$/i, '') || 'logo';
    return new File([pngBlob], `${baseName}.png`, { type: 'image/png' });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
