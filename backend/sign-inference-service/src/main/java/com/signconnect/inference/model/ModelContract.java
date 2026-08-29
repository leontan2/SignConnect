package com.signconnect.inference.model;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

public record ModelContract(
        Integer schemaVersion,
        String modelVersion,
        Boolean mockModel,
        List<Label> labels) {

    private static final Pattern LABEL_ID = Pattern.compile("^[A-Z][A-Z0-9_]{0,63}$");
    private static final Pattern MODEL_VERSION = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");

    public static ModelContract read(ObjectMapper objectMapper, InputStream input) throws IOException {
        ModelContract contract = objectMapper.readValue(input, ModelContract.class);
        contract.validate();
        return contract;
    }

    public void validate() {
        if (schemaVersion == null || schemaVersion != 1
                || modelVersion == null || !MODEL_VERSION.matcher(modelVersion).matches()
                || mockModel == null || labels == null || labels.isEmpty()) {
            throw new IllegalArgumentException("Label map does not match the model contract");
        }

        Set<String> ids = new HashSet<>();
        boolean includesNoSign = false;
        for (int position = 0; position < labels.size(); position++) {
            Label label = labels.get(position);
            if (label == null || label.index == null || label.index != position
                    || label.id == null || !LABEL_ID.matcher(label.id).matches()
                    || !ids.add(label.id)) {
                throw new IllegalArgumentException("Label map does not match the model contract");
            }
            if ("NO_SIGN".equals(label.id)) {
                includesNoSign = true;
                if (label.captionText != null) {
                    throw new IllegalArgumentException("Label map does not match the model contract");
                }
            } else if (label.captionText == null || label.captionText.isBlank()
                    || label.captionText.length() > 240) {
                throw new IllegalArgumentException("Label map does not match the model contract");
            }
        }
        if (!includesNoSign) {
            throw new IllegalArgumentException("Label map does not match the model contract");
        }
    }

    public Label labelAt(int index) {
        if (index < 0 || index >= labels.size()) {
            throw new IllegalArgumentException("Model output does not match the label map");
        }
        return labels.get(index);
    }

    @Override
    public String toString() {
        return "ModelContract[redacted]";
    }

    public record Label(Integer index, String id, String captionText) {

        @Override
        public String toString() {
            return "Label[redacted]";
        }
    }
}
