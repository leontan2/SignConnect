import {
  FRAMES_PER_LANDMARK_CHUNK,
  LANDMARK_CHUNK_TYPE,
  LANDMARK_FEATURE_COUNT,
  LANDMARK_SCHEMA_VERSION,
  type LandmarkChunk,
  type LandmarkChunkConsumer,
  type LandmarkFeatures,
  type LandmarkFrame
} from "./contracts";

export interface LandmarkFrameInput {
  timestampMs: number;
  features: LandmarkFeatures;
}

export interface LandmarkBatcherOptions {
  streamId: string;
  consumer: LandmarkChunkConsumer;
}

export interface LandmarkBatcherStats {
  bufferedFrames: number;
  pendingChunks: 0 | 1;
  droppedChunks: number;
}

export class LandmarkBatcher {
  private readonly streamIdValue: string;
  private readonly consumer: LandmarkChunkConsumer;
  private bufferedFrames: LandmarkFrame[] = [];
  private pendingChunk: LandmarkChunk | null = null;
  private nextFrameSequence = 0;
  private nextChunkSequence = 0;
  private lastTimestampMs = Number.NEGATIVE_INFINITY;
  private droppedChunks = 0;

  constructor(options: LandmarkBatcherOptions) {
    this.streamIdValue = options.streamId;
    this.consumer = options.consumer;
  }

  addFrame(input: LandmarkFrameInput): LandmarkChunk | null {
    if (input.features.length !== LANDMARK_FEATURE_COUNT || !input.features.every(Number.isFinite)) {
      throw new TypeError(`Landmark frames require exactly ${LANDMARK_FEATURE_COUNT} finite values.`);
    }
    if (!Number.isFinite(input.timestampMs) || input.timestampMs < 0 || input.timestampMs <= this.lastTimestampMs) {
      throw new RangeError("Landmark frame timestamps must be finite, non-negative, and strictly increasing.");
    }

    this.lastTimestampMs = input.timestampMs;
    this.bufferedFrames.push({
      sequence: this.nextFrameSequence,
      timestampMs: input.timestampMs,
      features: [...input.features]
    });
    this.nextFrameSequence += 1;

    if (this.bufferedFrames.length < FRAMES_PER_LANDMARK_CHUNK) return null;

    const chunk: LandmarkChunk = {
      schemaVersion: LANDMARK_SCHEMA_VERSION,
      type: LANDMARK_CHUNK_TYPE,
      streamId: this.streamIdValue,
      sequence: this.nextChunkSequence,
      frames: this.bufferedFrames
    };
    this.nextChunkSequence += 1;
    this.bufferedFrames = [];
    this.offerChunk(chunk);
    return chunk;
  }

  drain(): boolean {
    if (!this.pendingChunk || this.consumer.isUnderPressure()) return false;
    const chunk = this.pendingChunk;
    this.pendingChunk = null;
    this.consumer.send(chunk);
    return true;
  }

  clear(): void {
    this.bufferedFrames = [];
    this.pendingChunk = null;
  }

  get stats(): LandmarkBatcherStats {
    return {
      bufferedFrames: this.bufferedFrames.length,
      pendingChunks: this.pendingChunk ? 1 : 0,
      droppedChunks: this.droppedChunks
    };
  }

  private offerChunk(chunk: LandmarkChunk): void {
    if (this.consumer.isUnderPressure()) {
      if (this.pendingChunk) this.droppedChunks += 1;
      this.pendingChunk = chunk;
      return;
    }

    if (this.pendingChunk) {
      this.pendingChunk = null;
      this.droppedChunks += 1;
    }
    this.consumer.send(chunk);
  }
}
