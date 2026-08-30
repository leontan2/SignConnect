package com.signconnect.inference.model;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.signconnect.inference.SignInferenceServiceApplication;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.test.util.TestPropertyValues;
import org.springframework.context.ConfigurableApplicationContext;

import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

@ExtendWith(OutputCaptureExtension.class)
class InferenceModelConfigurationTest {

    private static final String MODEL_RESOURCE = "classpath:models/deterministic-sign-v1.onnx";
    private static final String LABEL_RESOURCE =
            "classpath:models/deterministic-sign-v1-labels.json";

    @TempDir
    Path temporaryDirectory;

    @Test
    void environmentOverridesSelectExplicitLocalFilesAndVersion() throws Exception {
        Path model = temporaryDirectory.resolve("deterministic-sign-v1.onnx");
        try (InputStream input = getClass().getResourceAsStream(
                "/models/deterministic-sign-v1.onnx")) {
            assertThat(input).isNotNull();
            Files.copy(input, model);
        }

        ObjectMapper objectMapper = new ObjectMapper();
        ObjectNode metadata;
        try (InputStream input = getClass().getResourceAsStream(
                "/models/deterministic-sign-v1-labels.json")) {
            assertThat(input).isNotNull();
            metadata = (ObjectNode) objectMapper.readTree(input);
        }
        metadata.put("modelVersion", "environment-override-v1");
        Path labels = temporaryDirectory.resolve("environment-metadata.json");
        Files.writeString(labels, objectMapper.writeValueAsString(metadata));

        TestPropertyValues.of(
                "SIGN_MODEL_RESOURCE=" + model.toUri(),
                "SIGN_MODEL_LABELS_RESOURCE=" + labels.toUri(),
                "SIGN_MODEL_EXPECTED_VERSION=environment-override-v1",
                "SIGN_MODEL_ALLOW_MOCK_MODEL=true")
                .applyToSystemProperties(() -> {
                    try (ConfigurableApplicationContext context = localContext()) {
                        OnnxModelRuntime runtime = context.getBean(OnnxModelRuntime.class);
                        assertThat(runtime.isReady()).isTrue();
                        assertThat(runtime.modelMode()).isEqualTo("synthetic");
                    }
                });
    }

    @Test
    void localMockEnvironmentOverrideCanDisableTheSyntheticFixture() throws Exception {
        TestPropertyValues.of("SIGN_MODEL_ALLOW_MOCK_MODEL=false")
                .applyToSystemProperties(() -> {
                    try (ConfigurableApplicationContext context = localContext()) {
                        assertThat(context.getBean(OnnxModelRuntime.class).isReady()).isFalse();
                    }
                });
    }

    @Test
    void defaultProfileDisallowsMockEvenWhenEnvironmentRequestsIt() throws Exception {
        TestPropertyValues.of(
                "SIGN_MODEL_RESOURCE=" + MODEL_RESOURCE,
                "SIGN_MODEL_LABELS_RESOURCE=" + LABEL_RESOURCE,
                "SIGN_MODEL_EXPECTED_VERSION=synthetic-v1",
                "SIGN_MODEL_ALLOW_MOCK_MODEL=true")
                .applyToSystemProperties(() -> {
                    try (ConfigurableApplicationContext context = context()) {
                        assertThat(context.getBean(OnnxModelRuntime.class).isReady()).isFalse();
                    }
                });
    }

    @Test
    void defaultLoggingEmitsOnlyTheGenericInitializationWarning(CapturedOutput output)
            throws Exception {
        Path privateModelPath = temporaryDirectory.resolve("private-sign-model.onnx");
        TestPropertyValues.of(
                "SIGN_MODEL_RESOURCE=" + privateModelPath.toUri(),
                "SIGN_MODEL_LABELS_RESOURCE=" + LABEL_RESOURCE,
                "SIGN_MODEL_EXPECTED_VERSION=synthetic-v1",
                "SIGN_MODEL_ALLOW_MOCK_MODEL=true")
                .applyToSystemProperties(() -> {
                    try (ConfigurableApplicationContext context = localContext()) {
                        assertThat(context.getBean(OnnxModelRuntime.class).isReady()).isFalse();
                    }
                });

        assertThat(output.getAll())
                .contains("Inference model initialization failed; readiness is unavailable")
                .doesNotContain(
                        "Inference model initialization detail",
                        "Configured model resource is unavailable",
                        "java.io.IOException",
                        privateModelPath.toString(),
                        privateModelPath.getFileName().toString());
    }

    private ConfigurableApplicationContext localContext() {
        return context("--spring.profiles.active=local", "--spring.main.banner-mode=off");
    }

    private ConfigurableApplicationContext context(String... arguments) {
        return new SpringApplicationBuilder(SignInferenceServiceApplication.class)
                .web(WebApplicationType.NONE)
                .logStartupInfo(false)
                .run(arguments);
    }
}
