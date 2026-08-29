import { describe, expect, it, vi } from "vitest";

import captionFixture from "../../../../../contracts/sign-recognition/v1/fixtures/server-caption-final.valid.json";
import controlFixture from "../../../../../contracts/sign-recognition/v1/fixtures/recognition-control-start.valid.json";
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
    expect(client.send(controlFixture)).toBe(false);
    expect(sockets[0].send).not.toHaveBeenCalled();
    sockets[0].bufferedAmount = 0;
    expect(client.send(controlFixture)).toBe(true);
    expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify(controlFixture));

    sockets[0].failClose();
    expect(scheduler.delays).toEqual([250]);
    expect(states.at(-1)).toMatchObject({ status: "reconnecting", retryDelayMs: 250 });
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
});
