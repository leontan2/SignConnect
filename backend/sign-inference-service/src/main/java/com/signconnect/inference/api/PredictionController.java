package com.signconnect.inference.api;

import com.signconnect.inference.model.OnnxModelRuntime;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/predictions")
public class PredictionController {

    private final OnnxModelRuntime modelRuntime;

    public PredictionController(OnnxModelRuntime modelRuntime) {
        this.modelRuntime = modelRuntime;
    }

    @PostMapping
    public PredictionResponse predict(@Valid @RequestBody PredictionRequest request) {
        return modelRuntime.predict(request);
    }
}
