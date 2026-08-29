import type { ClientRealtimeEvent, ServerRealtimeEvent } from "../api";
import { parseRealtimeEvent, type ParseRealtimeEventResult } from "./parseRealtimeEvent";

export type RealtimeConnectionStatus = "idle" | "connecting" | "connected" | "reconnecting";

export interface RealtimeConnectionState {
  status: RealtimeConnectionStatus;
  generation: number;
  recovered: boolean;
  retryDelayMs?: number;
}

export interface RealtimeSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeRetryScheduler {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface RealtimeClientOptions {
  meetingId: string;
  endpoint(meetingId: string): string;
  socketFactory?: (url: string) => RealtimeSocketLike;
  retryScheduler?: RealtimeRetryScheduler;
  maximumBufferedAmount?: number;
  onStateChange?: (state: RealtimeConnectionState) => void;
  onEvent?: (event: ServerRealtimeEvent, generation: number) => void;
  onParseIssue?: (issue: Extract<ParseRealtimeEventResult, { ok: false }>, generation: number) => void;
}

const SOCKET_OPEN = 1;
const DEFAULT_MAXIMUM_BUFFERED_AMOUNT = 256 * 1024;
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 5000] as const;

const defaultRetryScheduler: RealtimeRetryScheduler = {
  set: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clear: (handle) => window.clearTimeout(handle as number)
};

export class RealtimeClient {
  private readonly meetingId: string;
  private readonly endpoint: (meetingId: string) => string;
  private readonly socketFactory: (url: string) => RealtimeSocketLike;
  private readonly retryScheduler: RealtimeRetryScheduler;
  private readonly maximumBufferedAmount: number;
  private readonly onStateChange?: (state: RealtimeConnectionState) => void;
  private readonly onEvent?: (event: ServerRealtimeEvent, generation: number) => void;
  private readonly onParseIssue?: RealtimeClientOptions["onParseIssue"];

  private socket: RealtimeSocketLike | null = null;
  private retryHandle: unknown = null;
  private retryAttempt = 0;
  private generationValue = 0;
  private active = false;
  private hasOpened = false;

  constructor(options: RealtimeClientOptions) {
    this.meetingId = options.meetingId;
    this.endpoint = options.endpoint;
    this.socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.retryScheduler = options.retryScheduler ?? defaultRetryScheduler;
    this.maximumBufferedAmount = options.maximumBufferedAmount ?? DEFAULT_MAXIMUM_BUFFERED_AMOUNT;
    this.onStateChange = options.onStateChange;
    this.onEvent = options.onEvent;
    this.onParseIssue = options.onParseIssue;

    if (!Number.isFinite(this.maximumBufferedAmount) || this.maximumBufferedAmount <= 0) {
      throw new RangeError("maximumBufferedAmount must be a positive finite number.");
    }
  }

  get generation(): number {
    return this.generationValue;
  }

  connect(): void {
    if (this.active) return;
    this.active = true;
    this.retryAttempt = 0;
    this.openSocket(false);
  }

  disconnect(): void {
    if (!this.active && !this.socket && this.retryHandle === null) return;
    this.active = false;
    this.cancelRetry();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      if (socket.readyState < 2) socket.close(1000, "Session closed");
    }
    this.emitState({ status: "idle", generation: this.generationValue, recovered: false });
  }

  isOpen(): boolean {
    return this.active && this.socket?.readyState === SOCKET_OPEN;
  }

  isUnderPressure(): boolean {
    const socket = this.socket;
    return !this.active
      || !socket
      || socket.readyState !== SOCKET_OPEN
      || socket.bufferedAmount >= this.maximumBufferedAmount;
  }

  send(event: ClientRealtimeEvent): boolean {
    const socket = this.socket;
    if (this.isUnderPressure() || !socket) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  private openSocket(reconnecting: boolean): void {
    if (!this.active) return;
    this.cancelRetry();
    this.generationValue += 1;
    const generation = this.generationValue;
    this.emitState({
      status: reconnecting ? "reconnecting" : "connecting",
      generation,
      recovered: false
    });

    let socket: RealtimeSocketLike;
    try {
      socket = this.socketFactory(this.endpoint(this.meetingId));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      const recovered = this.hasOpened;
      this.hasOpened = true;
      this.retryAttempt = 0;
      this.emitState({ status: "connected", generation, recovered });
    };
    socket.onmessage = (message) => {
      if (!this.isCurrent(socket, generation)) return;
      const parsed = parseRealtimeEvent(message.data);
      if (parsed.ok) {
        this.onEvent?.(parsed.event, generation);
      } else {
        this.onParseIssue?.(parsed, generation);
      }
    };
    socket.onerror = () => {
      if (!this.isCurrent(socket, generation)) return;
      try {
        socket.close();
      } catch {
        this.scheduleReconnect();
      }
    };
    socket.onclose = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.active || this.retryHandle !== null) return;
    const delayIndex = Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1);
    const retryDelayMs = RETRY_DELAYS_MS[delayIndex];
    this.retryAttempt += 1;
    this.emitState({
      status: "reconnecting",
      generation: this.generationValue,
      recovered: false,
      retryDelayMs
    });
    this.retryHandle = this.retryScheduler.set(() => {
      this.retryHandle = null;
      this.openSocket(true);
    }, retryDelayMs);
  }

  private cancelRetry(): void {
    if (this.retryHandle === null) return;
    this.retryScheduler.clear(this.retryHandle);
    this.retryHandle = null;
  }

  private isCurrent(socket: RealtimeSocketLike, generation: number): boolean {
    return this.active && this.socket === socket && this.generationValue === generation;
  }

  private emitState(state: RealtimeConnectionState): void {
    this.onStateChange?.(state);
  }
}
