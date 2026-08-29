package com.signconnect.realtime.recognition;

import com.signconnect.realtime.api.LandmarkChunkEvent;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

public final class RollingLandmarkWindow {

    private static final int HAND_LANDMARK_COUNT = 42;
    private static final int FEATURES_PER_LANDMARK = 4;
    private static final int PRESENCE_OFFSET = 3;

    private final int windowFrames;
    private final int strideFrames;
    private final Deque<LandmarkChunkEvent.Frame> frames;
    private boolean emittedFirstWindow;
    private int framesSinceLastWindow;
    private long nextWindowSequence;

    public RollingLandmarkWindow(int windowFrames, int strideFrames) {
        if (windowFrames <= 0 || strideFrames <= 0 || strideFrames > windowFrames) {
            throw new IllegalArgumentException("Window and stride must be positive and bounded");
        }
        this.windowFrames = windowFrames;
        this.strideFrames = strideFrames;
        this.frames = new ArrayDeque<>(windowFrames);
    }

    public List<Window> append(List<LandmarkChunkEvent.Frame> newFrames) {
        List<Window> completed = new ArrayList<>();
        for (LandmarkChunkEvent.Frame source : newFrames) {
            if (frames.size() == windowFrames) {
                frames.removeFirst();
            }
            frames.addLast(copy(source));

            if (!emittedFirstWindow && frames.size() == windowFrames) {
                completed.add(snapshot());
                emittedFirstWindow = true;
                framesSinceLastWindow = 0;
            } else if (emittedFirstWindow) {
                framesSinceLastWindow++;
                if (framesSinceLastWindow == strideFrames) {
                    completed.add(snapshot());
                    framesSinceLastWindow = 0;
                }
            }
        }
        return List.copyOf(completed);
    }

    public int bufferedFrameCount() {
        return frames.size();
    }

    public void reset() {
        frames.clear();
        emittedFirstWindow = false;
        framesSinceLastWindow = 0;
        nextWindowSequence = 0;
    }

    private Window snapshot() {
        List<LandmarkChunkEvent.Frame> snapshot = List.copyOf(frames);
        return new Window(
                nextWindowSequence++,
                snapshot,
                hasRecentHandPresence(snapshot));
    }

    private boolean hasRecentHandPresence(List<LandmarkChunkEvent.Frame> snapshot) {
        int firstRecentFrame = Math.max(0, snapshot.size() - strideFrames);
        int handFeatureCount = HAND_LANDMARK_COUNT * FEATURES_PER_LANDMARK;
        for (int frameIndex = firstRecentFrame; frameIndex < snapshot.size(); frameIndex++) {
            List<Double> features = snapshot.get(frameIndex).features();
            for (int featureIndex = PRESENCE_OFFSET;
                    featureIndex < handFeatureCount;
                    featureIndex += FEATURES_PER_LANDMARK) {
                if (features.get(featureIndex) == 1.0) {
                    return true;
                }
            }
        }
        return false;
    }

    private static LandmarkChunkEvent.Frame copy(LandmarkChunkEvent.Frame frame) {
        return new LandmarkChunkEvent.Frame(
                frame.sequence(),
                frame.timestampMs(),
                List.copyOf(frame.features()));
    }

    public record Window(
            long sequence,
            List<LandmarkChunkEvent.Frame> frames,
            boolean recentHandPresent) {

        public Window {
            frames = List.copyOf(frames);
        }

        @Override
        public String toString() {
            return "Window[sequence=" + sequence
                    + ", recentHandPresent=" + recentHandPresent
                    + ", frames=redacted]";
        }
    }
}
