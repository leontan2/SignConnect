import type { CallSignalCommand, CallSignalEvent } from "../api";

export type PeerCallState = "idle" | "calling" | "connecting" | "connected" | "ended" | "failed";

export interface PeerConnectionLike {
  connectionState: RTCPeerConnectionState;
  onconnectionstatechange: ((event: Event) => void) | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  ontrack: ((event: RTCTrackEvent) => void) | null;
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
  createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit>;
  createAnswer(options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description?: RTCLocalSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | RTCIceCandidate | null): Promise<void>;
  close(): void;
}

type PeerCallControllerOptions = {
  participantId: string;
  send: (signal: CallSignalCommand) => boolean;
  peerConnectionFactory?: (configuration: RTCConfiguration) => PeerConnectionLike;
  idFactory?: () => string;
  iceServers?: RTCIceServer[];
  onStateChange?: (state: PeerCallState) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteMediaState?: (state: { audioEnabled: boolean; videoEnabled: boolean }) => void;
};

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export class PeerCallController {
  private readonly participantId: string;
  private readonly send: (signal: CallSignalCommand) => boolean;
  private readonly peerConnectionFactory: (configuration: RTCConfiguration) => PeerConnectionLike;
  private readonly idFactory: () => string;
  private readonly iceServers: RTCIceServer[];
  private readonly onStateChange?: (state: PeerCallState) => void;
  private readonly onRemoteStream?: (stream: MediaStream) => void;
  private readonly onRemoteMediaState?: (state: { audioEnabled: boolean; videoEnabled: boolean }) => void;
  private connection: PeerConnectionLike | null = null;
  private callId: string | null = null;
  private targetParticipantId: string | null = null;
  private remoteDescriptionSet = false;
  private pendingRemoteCandidates: CallSignalEvent[] = [];

  constructor(options: PeerCallControllerOptions) {
    this.participantId = options.participantId;
    this.send = options.send;
    this.peerConnectionFactory = options.peerConnectionFactory
      ?? ((configuration) => new RTCPeerConnection(configuration));
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.onStateChange = options.onStateChange;
    this.onRemoteStream = options.onRemoteStream;
    this.onRemoteMediaState = options.onRemoteMediaState;
  }

  async startCall(targetParticipantId: string, localStream: MediaStream): Promise<void> {
    this.closeConnection();
    this.pendingRemoteCandidates = [];
    this.callId = this.idFactory();
    this.targetParticipantId = targetParticipantId;
    const connection = this.createConnection(localStream);
    this.setState("calling");

    try {
      const offer = await connection.createOffer();
      await connection.setLocalDescription(offer);
      this.emit({ type: "call.offer", payload: { sdp: offer.sdp ?? "" } });
    } catch (error) {
      this.setState("failed");
      this.closeConnection();
      throw error;
    }
  }

  async handleSignal(signal: CallSignalEvent, localStream: MediaStream | null): Promise<void> {
    if (signal.targetParticipantId !== this.participantId) {
      return;
    }

    if (signal.type === "call.ice-candidate") {
      const candidateMatchesActiveCall = signal.callId === this.callId
        && signal.participantId === this.targetParticipantId
        && this.connection !== null;
      if (!candidateMatchesActiveCall || !this.remoteDescriptionSet) {
        this.pendingRemoteCandidates.push(signal);
        this.pendingRemoteCandidates = this.pendingRemoteCandidates.slice(-64);
      } else {
        await this.connection!.addIceCandidate(signal.payload);
      }
      return;
    }

    if (signal.type === "call.offer") {
      const queuedCandidates = this.pendingRemoteCandidates.filter((candidate) => (
        candidate.type === "call.ice-candidate"
        && candidate.callId === signal.callId
        && candidate.participantId === signal.participantId
      ));
      this.closeConnection();
      this.pendingRemoteCandidates = queuedCandidates;
      this.callId = signal.callId;
      this.targetParticipantId = signal.participantId;
      const connection = this.createConnection(localStream);
      this.setState("connecting");
      try {
        await connection.setRemoteDescription({ type: "offer", sdp: signal.payload.sdp });
        this.remoteDescriptionSet = true;
        await this.flushRemoteCandidates();
        const answer = await connection.createAnswer();
        await connection.setLocalDescription(answer);
        this.emit({ type: "call.answer", payload: { sdp: answer.sdp ?? "" } });
      } catch (error) {
        this.setState("failed");
        this.closeConnection();
        throw error;
      }
      return;
    }

    if (signal.callId !== this.callId || signal.participantId !== this.targetParticipantId) {
      return;
    }

    if (signal.type === "call.answer") {
      await this.connection?.setRemoteDescription({ type: "answer", sdp: signal.payload.sdp });
      this.remoteDescriptionSet = true;
      await this.flushRemoteCandidates();
      this.setState("connecting");
      return;
    }
    if (signal.type === "media.state") {
      this.onRemoteMediaState?.(signal.payload);
      return;
    }
    if (signal.type === "call.decline" || signal.type === "call.leave") {
      this.closeConnection();
      this.pendingRemoteCandidates = [];
      this.setState("ended");
    }
  }

  sendMediaState(audioEnabled: boolean, videoEnabled: boolean): void {
    if (!this.connection) {
      return;
    }
    this.emit({ type: "media.state", payload: { audioEnabled, videoEnabled } });
  }

  end(reason = "user_left", notify = true): void {
    if (notify && this.connection) {
      this.emit({ type: "call.leave", payload: { reason } });
    }
    this.closeConnection();
    this.pendingRemoteCandidates = [];
    this.setState("ended");
  }

  dispose(): void {
    this.end("session_closed", false);
  }

  private createConnection(localStream: MediaStream | null): PeerConnectionLike {
    const connection = this.peerConnectionFactory({ iceServers: this.iceServers });
    this.connection = connection;
    for (const track of localStream?.getTracks() ?? []) {
      connection.addTrack(track, localStream!);
    }
    connection.onicecandidate = (event) => {
      if (event.candidate) {
        this.emit({ type: "call.ice-candidate", payload: event.candidate.toJSON() });
      }
    };
    connection.ontrack = (event) => {
      const remoteStream = event.streams[0];
      if (remoteStream) {
        this.onRemoteStream?.(remoteStream);
      }
    };
    connection.onconnectionstatechange = () => {
      switch (connection.connectionState) {
        case "connected":
          this.setState("connected");
          break;
        case "connecting":
        case "new":
          this.setState("connecting");
          break;
        case "failed":
          this.setState("failed");
          break;
        case "closed":
        case "disconnected":
          this.setState("ended");
          break;
      }
    };
    return connection;
  }

  private emit(signal: Pick<CallSignalCommand, "type" | "payload">): void {
    if (!this.callId || !this.targetParticipantId) {
      throw new Error("Cannot send a call signal without an active peer call.");
    }
    const sent = this.send({
      schemaVersion: 1,
      signalId: this.idFactory(),
      callId: this.callId,
      targetParticipantId: this.targetParticipantId,
      ...signal
    } as CallSignalCommand);
    if (!sent) {
      throw new Error("The room connection is not ready for call signaling.");
    }
  }

  private closeConnection(): void {
    if (this.connection) {
      this.connection.onicecandidate = null;
      this.connection.ontrack = null;
      this.connection.onconnectionstatechange = null;
      this.connection.close();
      this.connection = null;
    }
    this.callId = null;
    this.targetParticipantId = null;
    this.remoteDescriptionSet = false;
  }

  private async flushRemoteCandidates(): Promise<void> {
    if (!this.connection || !this.callId || !this.targetParticipantId || !this.remoteDescriptionSet) return;
    const matchingCandidates = this.pendingRemoteCandidates.filter((candidate) => (
      candidate.type === "call.ice-candidate"
      && candidate.callId === this.callId
      && candidate.participantId === this.targetParticipantId
    ));
    this.pendingRemoteCandidates = this.pendingRemoteCandidates.filter(
      (candidate) => !matchingCandidates.includes(candidate)
    );
    for (const candidate of matchingCandidates) {
      if (candidate.type === "call.ice-candidate") {
        await this.connection.addIceCandidate(candidate.payload);
      }
    }
  }

  private setState(state: PeerCallState): void {
    this.onStateChange?.(state);
  }
}
