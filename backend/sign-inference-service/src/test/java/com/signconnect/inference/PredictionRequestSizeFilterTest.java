package com.signconnect.inference;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.ActiveProfiles;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "debug=false")
@ActiveProfiles("local")
@ExtendWith(OutputCaptureExtension.class)
class PredictionRequestSizeFilterTest {

    private static final String BODY_SENTINEL =
            "PRIVATE_CHUNKED_BODY_624288fe-5f9f-47e6-b433-3f91bd3f11cb";

    @LocalServerPort
    private int port;

    @Autowired
    private ObjectMapper objectMapper;

    @Test
    void boundsChunkedBodiesWithoutAContentLengthBeforeMvcBinding(CapturedOutput output)
            throws Exception {
        byte[] body = ("{\"private\":\"" + BODY_SENTINEL + "X".repeat(300_000) + "\"}")
                .getBytes(StandardCharsets.UTF_8);
        HttpRequest.BodyPublisher publisher = HttpRequest.BodyPublishers.ofInputStream(
                () -> new ByteArrayInputStream(body));
        assertThat(publisher.contentLength()).isEqualTo(-1L);

        HttpResponse<String> response = post(publisher);

        assertThat(response.statusCode()).isEqualTo(413);
        JsonNode error = objectMapper.readTree(response.body());
        assertThat(error.path("status").asInt()).isEqualTo(413);
        assertThat(error.path("code").asText()).isEqualTo("PAYLOAD_TOO_LARGE");
        assertThat(response.body()).doesNotContain(BODY_SENTINEL, "private", "XXX");
        assertThat(output.toString()).doesNotContain(BODY_SENTINEL);
    }

    @Test
    void replaysAnAllowedChunkedBodyToMvc() throws Exception {
        byte[] body = fixture("inference-request-active.valid.json");
        HttpRequest.BodyPublisher publisher = HttpRequest.BodyPublishers.ofInputStream(
                () -> new ByteArrayInputStream(body));
        assertThat(publisher.contentLength()).isEqualTo(-1L);

        HttpResponse<String> response = post(publisher);

        assertThat(response.statusCode()).isEqualTo(200);
        assertThat(objectMapper.readTree(response.body()).path("labelId").asText())
                .isEqualTo("MOCK_ACTIVE");
    }

    private HttpResponse<String> post(HttpRequest.BodyPublisher publisher)
            throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create("http://127.0.0.1:" + port + "/api/v1/predictions"))
                .version(HttpClient.Version.HTTP_1_1)
                .header("Content-Type", "application/json")
                .POST(publisher)
                .build();
        try (HttpClient client = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1)
                .build()) {
            return client.send(request, HttpResponse.BodyHandlers.ofString());
        }
    }

    private static byte[] fixture(String name) throws IOException {
        return Files.readAllBytes(contractsRoot().resolve("fixtures").resolve(name));
    }

    private static Path contractsRoot() {
        Path candidate = Path.of("").toAbsolutePath();
        while (candidate != null) {
            Path contracts = candidate.resolve("contracts/sign-recognition/v1");
            if (Files.isDirectory(contracts)) {
                return contracts;
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("Could not locate repository inference contracts");
    }
}
