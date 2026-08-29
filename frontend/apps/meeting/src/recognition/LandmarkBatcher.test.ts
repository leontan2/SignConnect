import { describe, expect, it, vi } from "vitest";

import validChunkFixture from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";
import { LandmarkBatcher as LandmarkBatcherUnderTest } from "./LandmarkBatcher";

type LandmarkFrameInput = {
  timestampMs: number;
  features: number[];
};

type LandmarkChunk = typeof validChunkFixture;

type ChunkConsumer = {
  isUnderPressure(): boolean;
  send(chunk: LandmarkChunk): void;
};

type Batcher = {
  addFrame(frame: LandmarkFrameInput): LandmarkChunk | null;
  drain(): boolean;
  readonly stats: {
    pendingChunks: number;
    droppedChunks: number;
    bufferedFrames: number;
  };
};

type BatcherConstructor = new (options: { streamId: string; consumer: ChunkConsumer }) => Batcher;

function batcherConstructorFor(_behavior: string): BatcherConstructor {
  return LandmarkBatcherUnderTest as unknown as BatcherConstructor;
}

describe("LandmarkBatcher", () => {
  it("emits exactly five frames with the v1 fixture shape and monotonic sequences", () => {
    const LandmarkBatcher = batcherConstructorFor("five-frame chunks");
    const send = vi.fn<(chunk: LandmarkChunk) => void>();
    const batcher = new LandmarkBatcher({
      streamId: validChunkFixture.streamId,
      consumer: { isUnderPressure: () => false, send }
    });

    const produced = validChunkFixture.frames.map((frame) => batcher.addFrame({
      timestampMs: frame.timestampMs,
      features: frame.features
    }));

    expect(produced.slice(0, 4)).toEqual([null, null, null, null]);
    expect(produced[4]).toEqual(validChunkFixture);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(validChunkFixture);
    expect(Object.keys(send.mock.calls[0][0])).toEqual([
      "schemaVersion",
      "type",
      "streamId",
      "sequence",
      "frames"
    ]);
  });

  it("retains only the latest complete unsent chunk while pressured", () => {
    const LandmarkBatcher = batcherConstructorFor("latest-wins pressure handling");
    let pressured = true;
    const send = vi.fn<(chunk: LandmarkChunk) => void>();
    const batcher = new LandmarkBatcher({
      streamId: validChunkFixture.streamId,
      consumer: { isUnderPressure: () => pressured, send }
    });

    for (let index = 0; index < 15; index += 1) {
      batcher.addFrame({
        timestampMs: index * 40,
        features: [...validChunkFixture.frames[index % 5].features]
      });
    }

    expect(send).not.toHaveBeenCalled();
    expect(batcher.stats).toMatchObject({
      pendingChunks: 1,
      droppedChunks: 2,
      bufferedFrames: 0
    });

    pressured = false;
    expect(batcher.drain()).toBe(true);

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0].sequence).toBe(2);
    expect(send.mock.calls[0][0].frames.map((frame) => frame.sequence)).toEqual([10, 11, 12, 13, 14]);
    expect(batcher.stats).toMatchObject({ pendingChunks: 0, droppedChunks: 2 });
    expect(batcher.drain()).toBe(false);
  });

  it("rejects malformed numeric input without retaining or sending it", () => {
    const LandmarkBatcher = batcherConstructorFor("finite feature validation");
    const send = vi.fn<(chunk: LandmarkChunk) => void>();
    const batcher = new LandmarkBatcher({
      streamId: validChunkFixture.streamId,
      consumer: { isUnderPressure: () => false, send }
    });

    expect(() => batcher.addFrame({ timestampMs: 0, features: [Number.NaN] })).toThrow(
      "exactly 224 finite values"
    );
    expect(send).not.toHaveBeenCalled();
    expect(batcher.stats.bufferedFrames).toBe(0);
  });
});
