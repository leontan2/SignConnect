import { afterEach, describe, expect, it, vi } from "vitest";

import {
  observeCanvasBackingStore,
  synchronizeCanvasBackingStore
} from "./overlayCanvas";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("overlay canvas backing-store synchronization", () => {
  it("tracks CSS size changes without waiting for another recognition frame", () => {
    let clientWidth = 640;
    let clientHeight = 480;
    const canvas = document.createElement("canvas");
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, get: () => clientWidth },
      clientHeight: { configurable: true, get: () => clientHeight }
    });

    let resizeCallback: ResizeObserverCallback | null = null;
    const observe = vi.fn();
    const disconnect = vi.fn();
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const onResize = vi.fn();

    const stop = observeCanvasBackingStore(canvas, onResize);
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 640, height: 480 });
    expect(observe).toHaveBeenCalledWith(canvas);
    expect(onResize).toHaveBeenCalledTimes(1);

    clientWidth = 320;
    clientHeight = 240;
    resizeCallback!([], {} as ResizeObserver);
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 320, height: 240 });
    expect(onResize).toHaveBeenCalledTimes(2);

    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("caps high-density backing stores and ignores invalid ratios", () => {
    const canvas = document.createElement("canvas");
    Object.defineProperties(canvas, {
      clientWidth: { configurable: true, value: 200 },
      clientHeight: { configurable: true, value: 100 }
    });

    expect(synchronizeCanvasBackingStore(canvas, 3)).toBe(true);
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 400, height: 200 });
    expect(synchronizeCanvasBackingStore(canvas, Number.NaN)).toBe(true);
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 200, height: 100 });
    expect(synchronizeCanvasBackingStore(canvas, 1)).toBe(false);
  });
});
