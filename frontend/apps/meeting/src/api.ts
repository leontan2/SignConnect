export type Meeting = {
  id: string;
  title: string;
  status: "READY" | "ACTIVE" | "ENDED";
  createdAt: string;
};

export type CaptionEvent = {
  type: "caption.final";
  meetingId: string;
  sequence: number;
  payload: {
    text: string;
    confidence: number;
  };
  occurredAt: string;
};

export async function createMeeting(title: string): Promise<Meeting> {
  const response = await fetch(`${process.env.MEETING_API_URL}/api/v1/meetings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title })
  });

  if (!response.ok) {
    throw new Error("Meeting service rejected the request");
  }

  return response.json() as Promise<Meeting>;
}

export function realtimeEndpoint(meetingId: string): string {
  return `${process.env.REALTIME_WS_URL}/ws/v1/realtime/${meetingId}`;
}