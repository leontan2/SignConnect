import { useCallback, useEffect, useRef, useState } from "react";

import {
  realtimeEndpoint,
  type ClientRealtimeEvent,
  type ServerRealtimeEvent
} from "../api";
import {
  RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeConnectionState,
  type RealtimeRetryScheduler,
  type RealtimeSocketLike
} from "./RealtimeClient";
import type { ParseRealtimeEventResult } from "./parseRealtimeEvent";

export interface UseRealtimeSessionOptions {
  endpoint?: (meetingId: string) => string;
  socketFactory?: (url: string) => RealtimeSocketLike;
  retryScheduler?: RealtimeRetryScheduler;
  maximumBufferedAmount?: number;
  onEvent?: (event: ServerRealtimeEvent, generation: number) => void;
  onParseIssue?: (issue: Extract<ParseRealtimeEventResult, { ok: false }>, generation: number) => void;
}

export interface UseRealtimeSessionResult {
  state: RealtimeConnectionState;
  connect(meetingId: string, realtimeTicket?: string): void;
  disconnect(): void;
  send(event: ClientRealtimeEvent): boolean;
  isUnderPressure(): boolean;
}

const INITIAL_CONNECTION_STATE: RealtimeConnectionState = {
  status: "idle",
  generation: 0,
  recovered: false
};

export function useRealtimeSession(options: UseRealtimeSessionOptions = {}): UseRealtimeSessionResult {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const clientRef = useRef<RealtimeClient | null>(null);
  const [state, setState] = useState<RealtimeConnectionState>(INITIAL_CONNECTION_STATE);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect();
    clientRef.current = null;
  }, []);

  const connect = useCallback((meetingId: string, realtimeTicket?: string) => {
    clientRef.current?.disconnect();
    const currentOptions = optionsRef.current;
    const clientOptions: RealtimeClientOptions = {
      meetingId,
      realtimeTicket,
      endpoint: currentOptions.endpoint ?? realtimeEndpoint,
      socketFactory: currentOptions.socketFactory,
      retryScheduler: currentOptions.retryScheduler,
      maximumBufferedAmount: currentOptions.maximumBufferedAmount,
      onStateChange: setState,
      onEvent: (event, generation) => optionsRef.current.onEvent?.(event, generation),
      onParseIssue: (issue, generation) => optionsRef.current.onParseIssue?.(issue, generation)
    };
    const client = new RealtimeClient(clientOptions);
    clientRef.current = client;
    client.connect();
  }, []);

  useEffect(() => disconnect, [disconnect]);

  const send = useCallback((event: ClientRealtimeEvent) => clientRef.current?.send(event) ?? false, []);
  const isUnderPressure = useCallback(() => clientRef.current?.isUnderPressure() ?? true, []);

  return { state, connect, disconnect, send, isUnderPressure };
}
