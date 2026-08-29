package com.signconnect.inference.api;

import com.signconnect.inference.config.InferenceLimitsProperties;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 10)
public final class PredictionRequestSizeFilter extends OncePerRequestFilter {

    static final String PREDICTIONS_PATH = "/api/v1/predictions";
    private static final String PAYLOAD_TOO_LARGE_BODY =
            "{\"status\":413,\"code\":\"PAYLOAD_TOO_LARGE\","
                    + "\"message\":\"Request body exceeds the inference limit\"}";

    private final int maxRequestBodyBytes;

    public PredictionRequestSizeFilter(InferenceLimitsProperties limits) {
        this.maxRequestBodyBytes = limits.maxRequestBodyBytes();
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !"POST".equals(request.getMethod()) || !PREDICTIONS_PATH.equals(requestPath(request));
    }

    @Override
    protected void doFilterInternal(
            HttpServletRequest request,
            HttpServletResponse response,
            FilterChain filterChain) throws ServletException, IOException {
        long declaredLength = request.getContentLengthLong();
        if (declaredLength > maxRequestBodyBytes) {
            reject(response);
            return;
        }

        byte[] body = readBounded(request);
        if (body == null) {
            reject(response);
            return;
        }

        filterChain.doFilter(new CachedBodyRequest(request, body), response);
    }

    private byte[] readBounded(HttpServletRequest request) throws IOException {
        int initialCapacity = request.getContentLengthLong() > 0
                ? (int) Math.min(request.getContentLengthLong(), maxRequestBodyBytes)
                : Math.min(8_192, maxRequestBodyBytes);
        ByteArrayOutputStream output = new ByteArrayOutputStream(initialCapacity);
        byte[] buffer = new byte[8_192];
        int remaining = maxRequestBodyBytes + 1;
        try (ServletInputStream input = request.getInputStream()) {
            while (remaining > 0) {
                int count = input.read(buffer, 0, Math.min(buffer.length, remaining));
                if (count < 0) {
                    break;
                }
                if (count == 0) {
                    continue;
                }
                output.write(buffer, 0, count);
                remaining -= count;
            }
        }
        if (output.size() > maxRequestBodyBytes) {
            return null;
        }
        return output.toByteArray();
    }

    private static void reject(HttpServletResponse response) throws IOException {
        response.reset();
        response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        try (PrintWriter writer = response.getWriter()) {
            writer.write(PAYLOAD_TOO_LARGE_BODY);
        }
    }

    private static String requestPath(HttpServletRequest request) {
        String path = request.getRequestURI();
        String contextPath = request.getContextPath();
        if (contextPath != null && !contextPath.isEmpty() && path.startsWith(contextPath)) {
            return path.substring(contextPath.length());
        }
        return path;
    }

    private static final class CachedBodyRequest extends HttpServletRequestWrapper {

        private final byte[] body;

        private CachedBodyRequest(HttpServletRequest request, byte[] body) {
            super(request);
            this.body = body.clone();
        }

        @Override
        public ServletInputStream getInputStream() {
            return new CachedBodyInputStream(body);
        }

        @Override
        public BufferedReader getReader() {
            String encoding = getCharacterEncoding();
            Charset charset = encoding == null
                    ? StandardCharsets.UTF_8
                    : Charset.forName(encoding);
            return new BufferedReader(new InputStreamReader(getInputStream(), charset));
        }

        @Override
        public int getContentLength() {
            return body.length;
        }

        @Override
        public long getContentLengthLong() {
            return body.length;
        }
    }

    private static final class CachedBodyInputStream extends ServletInputStream {

        private final ByteArrayInputStream input;

        private CachedBodyInputStream(byte[] body) {
            this.input = new ByteArrayInputStream(body);
        }

        @Override
        public boolean isFinished() {
            return input.available() == 0;
        }

        @Override
        public boolean isReady() {
            return true;
        }

        @Override
        public void setReadListener(ReadListener readListener) {
            if (readListener == null) {
                throw new IllegalArgumentException("ReadListener is required");
            }
            try {
                if (!isFinished()) {
                    readListener.onDataAvailable();
                }
                if (isFinished()) {
                    readListener.onAllDataRead();
                }
            } catch (IOException failure) {
                readListener.onError(failure);
            }
        }

        @Override
        public int read() {
            return input.read();
        }

        @Override
        public int read(byte[] bytes, int offset, int length) {
            return input.read(bytes, offset, length);
        }
    }
}
