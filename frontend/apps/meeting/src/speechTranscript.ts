export type SpeechCaptureHandlers = {
  onStart: () => void;
  onFinalTranscript: (text: string) => void;
  onError: (reason: string) => void;
  onEnd: () => void;
};

export type SpeechRecognitionController = {
  start: () => void;
  stop: () => void;
};

export type SpeechRecognitionFactory = (
  handlers: SpeechCaptureHandlers
) => SpeechRecognitionController | null;

type BrowserSpeechAlternative = {
  transcript: string;
};

type BrowserSpeechResult = {
  isFinal: boolean;
  readonly [index: number]: BrowserSpeechAlternative;
};

type BrowserSpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<BrowserSpeechResult>;
};

type BrowserSpeechErrorEvent = {
  error?: string;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: BrowserSpeechResultEvent) => void) | null;
  onerror: ((event: BrowserSpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechConstructor = new () => BrowserSpeechRecognition;

function browserSpeechConstructor(): BrowserSpeechConstructor | null {
  if (typeof window === "undefined") return null;
  const browserWindow = window as typeof window & {
    SpeechRecognition?: BrowserSpeechConstructor;
    webkitSpeechRecognition?: BrowserSpeechConstructor;
  };
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition ?? null;
}

export function browserSpeechRecognitionSupported(): boolean {
  return browserSpeechConstructor() !== null;
}

export const createBrowserSpeechRecognition: SpeechRecognitionFactory = (handlers) => {
  const Recognition = browserSpeechConstructor();
  if (!Recognition) return null;

  const recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = "en-SG";
  recognition.onstart = handlers.onStart;
  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result?.isFinal) handlers.onFinalTranscript(result[0]?.transcript ?? "");
    }
  };
  recognition.onerror = (event) => handlers.onError(event.error ?? "unknown");
  recognition.onend = handlers.onEnd;

  return {
    start: () => recognition.start(),
    stop: () => recognition.stop()
  };
};
