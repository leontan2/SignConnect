package com.signconnect.realtime.inference;

import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.signconnect.realtime.api.LandmarkChunkEvent;
import com.signconnect.realtime.config.RecognitionProperties;
import com.signconnect.realtime.recognition.RollingLandmarkWindow;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.Exceptions;
import reactor.core.publisher.Mono;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeoutException;
import java.util.regex.Pattern;

@Component
public class InferenceClient {

    private static final Pattern LABEL_ID = Pattern.compile("^[A-Z][A-Z0-9_]{0,63}$");
    private static final Pattern MODEL_VERSION = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");

    private final WebClient webClient;
    private final RecognitionProperties properties;

    public InferenceClient(WebClient.Builder webClientBuilder, RecognitionProperties properties) {
        this.webClient = webClientBuilder.baseUrl(properties.getInferenceUrl().toString()).build();
        this.properties = properties;
    }

    public Mono<Prediction> predict(
            UUID streamId,
            RollingLandmarkWindow.Window window) {
        PredictionRequest request = new PredictionRequest(
                1,
                UUID.randomUUID(),
                streamId,
                window.sequence(),
                window.frames());

        return webClient.post()
                .uri("/api/v1/predictions")
                .bodyValue(request)
                .exchangeToMono(response -> decode(response.statusCode(), response.bodyToMono(Prediction.class),
                        response.releaseBody()))
                .timeout(properties.getInferenceTimeout())
                .flatMap(prediction -> prediction.hasValidContract(request)
                        ? Mono.just(prediction)
                        : Mono.error(new InferenceUnavailableException(FailureReason.SERVICE_UNAVAILABLE)))
                .onErrorMap(
                        error -> !(error instanceof InferenceUnavailableException),
                        error -> new InferenceUnavailableException(
                                Exceptions.unwrap(error) instanceof TimeoutException
                                        ? FailureReason.TIMEOUT
                                        : FailureReason.SERVICE_UNAVAILABLE));
    }

    private static Mono<Prediction> decode(
            HttpStatusCode status,
            Mono<Prediction> body,
            Mono<Void> releaseBody) {
        if (status.is2xxSuccessful()) {
            return body.switchIfEmpty(Mono.error(
                    new InferenceUnavailableException(FailureReason.SERVICE_UNAVAILABLE)));
        }
        FailureReason reason = status.value() == 503
                ? FailureReason.SERVICE_UNAVAILABLE
                : FailureReason.SERVICE_UNAVAILABLE;
        return releaseBody.then(Mono.error(new InferenceUnavailableException(reason)));
    }

    public enum FailureReason {
        TIMEOUT,
        SERVICE_UNAVAILABLE
    }

    public static final class InferenceUnavailableException extends RuntimeException {

        private final FailureReason reason;

        public InferenceUnavailableException(FailureReason reason) {
            super("Inference request failed safely");
            this.reason = reason;
        }

        public FailureReason reason() {
            return reason;
        }
    }

    private record PredictionRequest(
            int schemaVersion,
            UUID requestId,
            UUID streamId,
            long windowSequence,
            List<LandmarkChunkEvent.Frame> frames) {

        private PredictionRequest {
            frames = List.copyOf(frames);
        }

        @Override
        public String toString() {
            return "PredictionRequest[redacted]";
        }
    }

    public record Prediction(
            Integer schemaVersion,
            @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID requestId,
            @JsonDeserialize(using = LandmarkChunkEvent.CanonicalUuidDeserializer.class) UUID streamId,
            Long windowSequence,
            String labelId,
            String captionText,
            Double confidence,
            String modelVersion,
            Double inferenceLatencyMs,
            Boolean mockModel) {

        private boolean hasValidContract(PredictionRequest request) {
            return schemaVersion != null && schemaVersion == 1
                    && request.requestId().equals(requestId)
                    && request.streamId().equals(streamId)
                    && windowSequence != null && windowSequence == request.windowSequence()
                    && labelId != null && LABEL_ID.matcher(labelId).matches()
                    && validCaption()
                    && confidence != null && Double.isFinite(confidence)
                    && confidence >= 0.0 && confidence <= 1.0
                    && modelVersion != null && MODEL_VERSION.matcher(modelVersion).matches()
                    && inferenceLatencyMs != null && Double.isFinite(inferenceLatencyMs)
                    && inferenceLatencyMs >= 0.0
                    && mockModel != null;
        }

        private boolean validCaption() {
            if ("NO_SIGN".equals(labelId)) {
                return captionText == null;
            }
            return captionText != null && !captionText.isBlank() && captionText.length() <= 240;
        }

        @Override
        public String toString() {
            return "Prediction[requestId=" + requestId
                    + ", streamId=" + streamId
                    + ", windowSequence=" + windowSequence
                    + ", labelId=" + labelId
                    + ", modelVersion=" + modelVersion
                    + ", mockModel=" + mockModel + "]";
        }
    }
}
