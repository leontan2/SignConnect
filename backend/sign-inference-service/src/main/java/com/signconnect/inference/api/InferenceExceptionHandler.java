package com.signconnect.inference.api;

import com.signconnect.inference.model.OnnxModelRuntime.ModelUnavailableException;
import com.signconnect.inference.model.InferenceConcurrencyLimiter.InferenceBusyException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.BindException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class InferenceExceptionHandler {

    private static final ApiError INVALID_REQUEST = new ApiError(
            400,
            "INVALID_REQUEST",
            "Request does not match inference contract");
    private static final ApiError MODEL_UNAVAILABLE = new ApiError(
            503,
            "MODEL_UNAVAILABLE",
            "Inference model is not ready");
    private static final ApiError INFERENCE_BUSY = new ApiError(
            503,
            "INFERENCE_BUSY",
            "Inference capacity is busy");

    @ExceptionHandler({
            MethodArgumentNotValidException.class,
            HttpMessageNotReadableException.class,
            BindException.class,
            IllegalArgumentException.class
    })
    public ResponseEntity<ApiError> invalidRequest(Exception ignored) {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(INVALID_REQUEST);
    }

    @ExceptionHandler(ModelUnavailableException.class)
    public ResponseEntity<ApiError> modelUnavailable(ModelUnavailableException ignored) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(MODEL_UNAVAILABLE);
    }

    @ExceptionHandler(InferenceBusyException.class)
    public ResponseEntity<ApiError> inferenceBusy(InferenceBusyException ignored) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(INFERENCE_BUSY);
    }

    public record ApiError(int status, String code, String message) {
    }
}
