import { describe, expect, it, vi } from "vitest";

import type { CallSignalCommand } from "../api";
import { PeerCallController, type PeerConnectionLike } from "./PeerCallController";

function fakeConnection() {
  const connection = {
    connectionState: "new",
    onconnectionstatechange: null,
    onicecandidate: null,
    ontrack: null,
    addTrack: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0\r\no=host" })),
    createAnswer: vi.fn(async () => ({ type: "answer", sdp: "v=0\r\no=guest" })),
    setLocalDescription: vi.fn(async () => undefined),
    setRemoteDescription: vi.fn(async () => undefined),
    addIceCandidate: vi.fn(async () => undefined),
    close: vi.fn()
  } as unknown as PeerConnectionLike;
  return connection;
}

describe("PeerCallController", () => {
  it("starts a call with the existing camera stream and emits targeted offer and ICE signals", async () => {
    const connection = fakeConnection();
    const sent: CallSignalCommand[] = [];
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333"
    ];
    const controller = new PeerCallController({
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      peerConnectionFactory: () => connection,
      idFactory: () => ids.shift()!,
      send: (signal) => {
        sent.push(signal);
        return true;
      }
    });
    const videoTrack = { kind: "video" } as MediaStreamTrack;
    const audioTrack = { kind: "audio" } as MediaStreamTrack;
    const stream = { getTracks: () => [videoTrack, audioTrack] } as unknown as MediaStream;

    await controller.startCall("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", stream);

    expect(connection.addTrack).toHaveBeenCalledTimes(2);
    expect(connection.addTrack).toHaveBeenNthCalledWith(1, videoTrack, stream);
    expect(connection.addTrack).toHaveBeenNthCalledWith(2, audioTrack, stream);
    expect(sent[0]).toEqual({
      schemaVersion: 1,
      type: "call.offer",
      signalId: "22222222-2222-4222-8222-222222222222",
      callId: "11111111-1111-4111-8111-111111111111",
      targetParticipantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      payload: { sdp: "v=0\r\no=host" }
    });

    connection.onicecandidate?.({
      candidate: { toJSON: () => ({ candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 }) }
    } as RTCPeerConnectionIceEvent);
    expect(sent[1]).toEqual({
      schemaVersion: 1,
      type: "call.ice-candidate",
      signalId: "33333333-3333-4333-8333-333333333333",
      callId: "11111111-1111-4111-8111-111111111111",
      targetParticipantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      payload: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 }
    });
  });

  it("queues trickle ICE received before an incoming offer is explicitly accepted", async () => {
    const connection = fakeConnection();
    const sent: CallSignalCommand[] = [];
    const controller = new PeerCallController({
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      peerConnectionFactory: () => connection,
      idFactory: () => "44444444-4444-4444-8444-444444444444",
      send: (signal) => {
        sent.push(signal);
        return true;
      }
    });
    const envelope = {
      schemaVersion: 1 as const,
      meetingId: "99999999-9999-4999-8999-999999999999",
      participantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      targetParticipantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      callId: "55555555-5555-4555-8555-555555555555",
      sequence: 4,
      occurredAt: "2026-08-31T00:00:00Z"
    };

    await controller.handleSignal({
      ...envelope,
      type: "call.ice-candidate",
      signalId: "66666666-6666-4666-8666-666666666666",
      payload: { candidate: "candidate:early", sdpMid: "0", sdpMLineIndex: 0 }
    }, null);
    expect(connection.addIceCandidate).not.toHaveBeenCalled();

    await controller.handleSignal({
      ...envelope,
      type: "call.offer",
      signalId: "77777777-7777-4777-8777-777777777777",
      payload: { sdp: "v=0\r\no=host" }
    }, null);

    expect(connection.setRemoteDescription).toHaveBeenCalledWith({ type: "offer", sdp: "v=0\r\no=host" });
    expect(connection.addIceCandidate).toHaveBeenCalledWith({
      candidate: "candidate:early",
      sdpMid: "0",
      sdpMLineIndex: 0
    });
    expect(sent).toContainEqual(expect.objectContaining({ type: "call.answer" }));
  });
});
