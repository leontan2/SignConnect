const MAX_CANVAS_PIXEL_RATIO = 2;

export function synchronizeCanvasBackingStore(
  canvas: HTMLCanvasElement,
  pixelRatio = window.devicePixelRatio || 1
): boolean {
  const normalizedPixelRatio = Number.isFinite(pixelRatio) && pixelRatio > 0
    ? Math.min(pixelRatio, MAX_CANVAS_PIXEL_RATIO)
    : 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return false;

  const targetWidth = Math.round(width * normalizedPixelRatio);
  const targetHeight = Math.round(height * normalizedPixelRatio);
  if (canvas.width === targetWidth && canvas.height === targetHeight) return false;

  canvas.width = targetWidth;
  canvas.height = targetHeight;
  return true;
}

export function observeCanvasBackingStore(
  canvas: HTMLCanvasElement,
  onResize: () => void
): () => void {
  const synchronize = () => {
    if (synchronizeCanvasBackingStore(canvas)) onResize();
  };
  synchronize();

  const observer = typeof ResizeObserver === "undefined"
    ? null
    : new ResizeObserver(synchronize);
  observer?.observe(canvas);
  window.addEventListener("resize", synchronize);

  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", synchronize);
  };
}
