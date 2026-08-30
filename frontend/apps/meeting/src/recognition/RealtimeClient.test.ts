import { describe, expect, it, vi } from "vitest";

import captionFixture from "../../../../../contracts/sign-recognition/v1/fixtures/server-caption-final.valid.json";
import controlFixture from "../../../../../contracts/sign-recognition/v1/fixtures/recognition-control-start.valid.json";
import landmarkFixture from "../../../../../contracts/sign-recognition/v1/fixtures/landmark-chunk.valid.json";
import roomNotFoundFixture from "../../../../../contracts/realtime-room/v1/fixtures/server-room-error-room-not-found.valid.json";
import * as meetingApi from "../api";

type SocketHandler = ((event: Event) => void) | null;
type MessageHandler = ((event: MessageEvent<string>) => void) | null;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  onopen: SocketHandler = null;
  onclose: SocketHandler = null;
  onerror: SocketHandler = null;
  onmessage: MessageHandler = null;
  readonly send = vi.fn<(data: string) => void>();
  readonly close = vi.fn(() => {
    this.readyState = FakeSocket.CLOSED;
  });

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  failClose(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  message(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
}

class ManualRetryScheduler {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, () => void>();
  readonly delays: number[] = [];
  readonly cleared: number[] = [];

  set(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.delays.push(delayMs);
    this.callbacks.set(handle, callback);
    return handle;
  }

  clear(handle: number): void {
    this.cleared.push(handle);
    this.callbacks.delete(handle);
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("No retry was scheduled");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

type RealtimeClientLike = {
  connect(): void;
  disconnect(): void;
  send(event: unknown): boolean;
  isUnderPressure(): boolean;
};

type RealtimeClientConstructor = new (options: Record<string, unknown>) => RealtimeClientLike;

describe("RealtimeClient", () => {
  it("authenticates the socket before reporting the room as connected", () => {
    const RealtimeClient = (meetingApi as unknown as {
      RealtimeClient?: RealtimeClientConstructor;
    }).RealtimeClient;
    expect(RealtimeClient).toBeTypeOf("function");
    if (!RealtimeClient) return;

    const socket = new FakeSocket();
    const states: Array<Record<string, unknown>> = [];
    const client = new RealtimeClient({
      meetingId: captionFixture.meetingId,
      realtimeTicket: "signed-ticket",
      endpoint: (meetingId: string) => `ws://realtime.test/${meetingId}`,
      socketFactory: () => socket,
      onStateChange: (state: Record<string, unknown>) => states.push(state)
    });

    client.connect();
    socket.open();

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({
      schemaVersion: 1,
      type: "room.join",
      ticket: "signed-ticket"
    }));
    expect(states.at(-1)).toMatchObject({ status: "joining", generation: 1 });
    expect(client.isUnderPressure()).toBe(true);

    socket.message({
      schemaVersion: 1,
      type: "room.joined",
      meetingId: captionFixture.meetingId,
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sequence: 0,
      payload: { displayName: "Leon", role: "HOST" },
      occurredAt: captionFixture.occurredAt
    });

    expect(states.at(-1)).toMatchObject({ status: "connected", generation: 1 });
    expect(client.isUnderPressure()).toBe(false);
    expect(client.send(controlFixture)).toBe(true);
  });

  it("uses the issued resume token instead of an expired realtime ticket after reconnect", () => {
    const RealtimeClient = (meetingApi as unknown as {
      RealtimeClient?: RealtimeClientConstructor;
    }).RealtimeClient;
    expect(RealtimeClient).toBeTypeOf("function");
    if (!RealtimeClient) return;

    const sockets: FakeSocket[] = [];
    const scheduler = new ManualRetryScheduler();
    const client = new RealtimeClient({
      meetingId: captionFixture.meetingId,
      realtimeTicket: "signed-ticket",
      endpoint: (meetingId: string) => `ws://realtime.test/${meetingId}`,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      retryScheduler: scheduler
    });

    client.connect();
    sockets[0].open();
    sockets[0].message({
      schemaVersion: 1,
      type: "room.joined",
      meetingId: captionFixture.meetingId,
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      resumeToken: "short-lived-resume-token",
      resumeExpiresAt: "2026-08-30T14:00:00Z",
      sequence: 0,
      payload: { displayName: "Leon", role: "HOST", activeSigner: false },
      occurredAt: captionFixture.occurredAt
    });
    sockets[0].failClose();
    scheduler.runNext();
    sockets[1].open();

    expect(sockets[1].send).toHaveBeenCalledWith(JSON.stringify({
      schemaVersion: 1,
      type: "room.join",
      resumeToken: "short-lived-resume-token"
    }));
  });

  it("delivers a fatal missing-room resume error and stops reconnecting", () => {
    const RealtimeClient = (meetingApi as unknown as {
      RealtimeClient?: RealtimeClientConstructor;
    }).RealtimeClient;
    expect(RealtimeClient).toBeTypeOf("function");
    if (!RealtimeClient) return;

    const sockets: FakeSocket[] = [];
    const scheduler = new ManualRetryScheduler();
    const states: Array<Record<string, unknown>> = [];
    const events: unknown[] = [];
    const client = new RealtimeClient({
      meetingId: roomNotFoundFixture.meetingId,
      realtimeTicket: "signed-ticket",
      endpoint: (meetingId: string) => `ws://realtime.test/${meetingId}`,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      retryScheduler: scheduler,
      onStateChange: (state: Record<string, unknown>) => states.push(state),
      onEvent: (event: unknown) => events.push(event)
    });

    client.connect();
    sockets[0].open();
    sockets[0].message({
      schemaVersion: 1,
      type: "room.joined",
      meetingId: roomNotFoundFixture.meetingId,
      participantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      resumeToken: "short-lived-resume-token",
      resumeExpiresAt: "2026-08-30T14:00:00Z",
      sequence: 0,
      payload: { displayName: "Leon", role: "HOST", activeSigner: false },
      occurredAt: roomNotFoundFixture.occurredAt
    });
    sockets[0].failClose();
    scheduler.runNext();
    sockets[1].open();
    expect(sockets[1].send).toHaveBeenCalledWith(JSON.stringify({
      schemaVersion: 1,
      type: "room.join",
      resumeToken: "short-lived-resume-token"
    }));

    sockets[1].message(roomNotFoundFixture);

    expect(events.at(-1)).toEqual(roomNotFoundFixture);
    expect(states.at(-1)).toMatchObject({ status: "idle", generation: 2 });
    expect(scheduler.pendingCount).toBe(0);
    sockets[1].failClose();
    expect(scheduler.pendingCount).toBe(0);
  });

  it("bounds pressure and retry delay, resets generations, rejects stale callbacks, and cleans up", () => {
    const RealtimeClient = (meetingApi as unknown as {
      RealtimeClient?: RealtimeClientConstructor;
    }).RealtimeClient;
    expect(RealtimeClient).toBeTypeOf("function");
    if (!RealtimeClient) return;

    const sockets: FakeSocket[] = [];
    const scheduler = new ManualRetryScheduler();
    const states: Array<Record<string, unknown>> = [];
    const events: unknown[] = [];
    const issues: unknown[] = [];
    const client = new RealtimeClient({
      meetingId: captionFixture.meetingId,
      endpoint: (meetingId: string) => `ws://realtime.test/${meetingId}`,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      retryScheduler: scheduler,
      maximumBufferedAmount: 64,
      onStateChange: (state: Record<string, unknown>) => states.push(state),
      onEvent: (event: unknown) => events.push(event),
      onParseIssue: (issue: unknown) => issues.push(issue)
    });

    client.connect();
    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(states.at(-1)).toMatchObject({ status: "connected", generation: 1, recovered: false });

    sockets[0].bufferedAmount = 64;
    expect(client.isUnderPressure()).toBe(true);
    expect(client.send(landmarkFixture)).toBe(false);
    expect(sockets[0].send).not.toHaveBeenCalled();

    expect(client.send(controlFixture)).toBe(false);
    expect(sockets[0].close).toHaveBeenCalledWith(4001, "Essential realtime send blocked");
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", retryDelayMs: 250 });
    expect(scheduler.pendingCount).toBe(1);
    scheduler.runNext();

    sockets[1].failClose();
    scheduler.runNext();
    sockets[2].failClose();
    scheduler.runNext();
    sockets[3].failClose();
    scheduler.runNext();
    sockets[4].failClose();
    scheduler.runNext();
    sockets[5].failClose();
    expect(scheduler.delays).toEqual([250, 500, 1000, 2000, 5000, 5000]);

    scheduler.runNext();
    sockets[6].open();
    expect(states.at(-1)).toMatchObject({ status: "connected", generation: 7, recovered: true });

    sockets[0].message(captionFixture);
    expect(events).toHaveLength(0);
    sockets[6].message(captionFixture);
    expect(events).toEqual([captionFixture]);
    sockets[6].message({ ...captionFixture, type: "caption.partial" });
    expect(issues).toHaveLength(1);

    sockets[6].failClose();
    expect(scheduler.delays.at(-1)).toBe(250);
    client.disconnect();
    expect(scheduler.pendingCount).toBe(0);
    expect(states.at(-1)).toMatchObject({ status: "idle" });
  });

  it("fails closed and reconnects when an essential control send throws", () => {
    const RealtimeClient = (meetingApi as unknown as {
      RealtimeClient?: RealtimeClientConstructor;
    }).RealtimeClient;
    expect(RealtimeClient).toBeTypeOf("function");
    if (!RealtimeClient) return;

    const socket = new FakeSocket();
    const scheduler = new ManualRetryScheduler();
    const states: Array<Record<string, unknown>> = [];
    const client = new RealtimeClient({
      meetingId: captionFixture.meetingId,
      endpoint: (meetingId: string) => `ws://realtime.test/${meetingId}`,
      socketFactory: () => socket,
      retryScheduler: scheduler,
      onStateChange: (state: Record<string, unknown>) => states.push(state)
    });

    client.connect();
    socket.open();
    socket.send.mockImplementationOnce(() => {
      throw new Error("socket send failed");
    });

    expect(client.send(controlFixture)).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(4001, "Essential realtime send failed");
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", retryDelayMs: 250 });
    expect(scheduler.pendingCount).toBe(1);
  });
});
