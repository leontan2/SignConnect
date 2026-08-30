package com.signconnect.inference.model;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigInteger;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

/**
 * Runtime representation of the authoritative
 * {@code contracts/sign-recognition-training/v1/model-metadata.schema.json} document.
 */
public record ModelContract(
        Integer schemaVersion,
        String modelId,
        String modelVersion,
        String generatedAt,
        Boolean mockModel,
        Boolean genuineSignLanguageData,
        String targetLanguage,
        ArchitectureMetadata architecture,
        String artifactSha256,
        InputMetadata input,
        OutputMetadata output,
        DecisionMetadata decision,
        List<Label> labels,
        TrainingDatasetMetadata trainingDataset,
        EvaluationMetadata evaluation,
        OnnxMetadata onnx,
        RuntimeMetadata runtime,
        SgslReviewMetadata sgslReview,
        GovernanceMetadata governance,
        ProductionPromotionMetadata productionPromotion) {

    public static final String FEATURE_LAYOUT_VERSION = "mediapipe-holistic-224-v1";
    public static final String NORMALIZATION_VERSION = "shoulder-midpoint-shoulder-width-v1";
    public static final List<String> FEATURE_ORDER = List.of(
            "LEFT_HAND_0_20_XYZ_PRESENCE",
            "RIGHT_HAND_0_20_XYZ_PRESENCE",
            "POSE_11_24_XYZ_PRESENCE");
    public static final List<Integer> INPUT_SHAPE = List.of(1, 30, 224);

    private static final String INPUT_NAME = "features";
    private static final String OUTPUT_NAME = "probabilities";
    private static final String TENSOR_TYPE = "FLOAT32";
    private static final String OUTPUT_SEMANTICS = "softmax-class-probabilities-v1";
    private static final String TARGET_LANGUAGE = "sg-SG";
    private static final String RUNTIME_ENGINE = "ONNX_RUNTIME_JAVA";
    private static final String REVIEWER_ROLE = "SGSL_FLUENT_DEAF_REVIEWER";
    private static final Pattern LABEL_ID = Pattern.compile("^[A-Z][A-Z0-9_]{0,63}$");
    private static final Pattern ENTITY_ID = Pattern.compile("^[a-z][a-z0-9-]{2,63}$");
    private static final Pattern MODEL_VERSION = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
    private static final Pattern SEMANTIC_VERSION = Pattern.compile(
            "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[a-z0-9.-]+)?$");
    private static final Pattern RUNTIME_VERSION = Pattern.compile("^[0-9]+\\.[0-9]+\\.[0-9]+$");
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern TIMESTAMP = Pattern.compile(
            "^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
                    + "T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?Z$");
    private static final Pattern MANIFEST_PATH = Pattern.compile(
            "^manifests/(?:[A-Za-z0-9][A-Za-z0-9._-]*/)*"
                    + "[A-Za-z0-9][A-Za-z0-9._-]*\\.json$");
    private static final Pattern ONNX_PATH = Pattern.compile(
            "^models/(?:[A-Za-z0-9][A-Za-z0-9._-]*/)*"
                    + "[A-Za-z0-9][A-Za-z0-9._-]*\\.onnx$");
    private static final Pattern SPDX_EXPRESSION = Pattern.compile("^[A-Za-z0-9][A-Za-z0-9.+() -]*$");

    public static ModelContract read(ObjectMapper objectMapper, InputStream input) throws IOException {
        ModelContract contract = objectMapper.readerFor(ModelContract.class)
                .with(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                .readValue(input);
        contract.validate();
        return contract;
    }

    public void validate() {
        if (schemaVersion == null || schemaVersion != 1
                || !matches(ENTITY_ID, modelId)
                || !matches(MODEL_VERSION, modelVersion)
                || !isTimestamp(generatedAt)
                || mockModel == null || genuineSignLanguageData == null
                || !TARGET_LANGUAGE.equals(targetLanguage)
                || architecture == null
                || !matches(SHA256, artifactSha256)
                || input == null || output == null || decision == null
                || labels == null || labels.size() < 2
                || trainingDataset == null || evaluation == null || onnx == null
                || runtime == null || sgslReview == null || governance == null
                || productionPromotion == null) {
            throw invalidMetadata();
        }

        architecture.validate();
        input.validate();
        output.validate(labels.size());
        decision.validate();
        Map<String, Label> labelsById = validateLabels();
        trainingDataset.validate();
        evaluation.validate();
        onnx.validate();
        runtime.validate();
        sgslReview.validate(labelsById);
        governance.validate();
        productionPromotion.validate(this);
    }

    private Map<String, Label> validateLabels() {
        Set<String> ids = new HashSet<>();
        int noSignCount = 0;
        int signCount = 0;
        for (int position = 0; position < labels.size(); position++) {
            Label label = labels.get(position);
            if (label == null || label.index == null || label.index != position
                    || !matches(LABEL_ID, label.id)
                    || label.outcome == null || !ids.add(label.id)) {
                throw invalidMetadata();
            }
            switch (label.outcome) {
                case NO_SIGN -> {
                    noSignCount++;
                    if (!"NO_SIGN".equals(label.id) || label.captionText != null) {
                        throw invalidMetadata();
                    }
                }
                case REJECT -> {
                    if ("NO_SIGN".equals(label.id) || label.captionText != null) {
                        throw invalidMetadata();
                    }
                }
                case SIGN -> {
                    signCount++;
                    if ("NO_SIGN".equals(label.id)
                            || label.captionText == null || label.captionText.isBlank()
                            || label.captionText.length() > 240) {
                        throw invalidMetadata();
                    }
                }
            }
        }
        if (noSignCount != 1 || signCount == 0) {
            throw invalidMetadata();
        }
        return labels.stream().collect(Collectors.toUnmodifiableMap(Label::id, Function.identity()));
    }

    public Label labelAt(int index) {
        if (index < 0 || index >= labels.size()) {
            throw new IllegalArgumentException("Model output does not match the label map");
        }
        return labels.get(index);
    }

    boolean isProductionReady() {
        return productionPromotion.status() == PromotionStatus.APPROVED
                && Boolean.TRUE.equals(genuineSignLanguageData)
                && Boolean.FALSE.equals(mockModel);
    }

    private static boolean matches(Pattern pattern, String value) {
        return value != null && pattern.matcher(value).matches();
    }

    private static boolean isTimestamp(String value) {
        if (!matches(TIMESTAMP, value)) {
            return false;
        }
        try {
            Instant.parse(value);
            return true;
        } catch (DateTimeParseException ignored) {
            return false;
        }
    }

    private static boolean isProbability(Double value) {
        return isFinite(value) && value >= 0.0 && value <= 1.0;
    }

    private static boolean isFinite(Double value) {
        return value != null && Double.isFinite(value);
    }

    private static IllegalArgumentException invalidMetadata() {
        return new IllegalArgumentException("Model metadata does not match the inference contract");
    }

    @Override
    public String toString() {
        return "ModelContract[redacted]";
    }

    public record ArchitectureMetadata(
            ArchitectureFamily family,
            String name,
            Long parameterCount) {

        private void validate() {
            if (family == null || name == null || name.isBlank() || name.length() > 128
                    || parameterCount == null || parameterCount < 0) {
                throw invalidMetadata();
            }
        }
    }

    public enum ArchitectureFamily {
        TCN,
        GRU,
        BILSTM,
        ST_GCN,
        SYNTHETIC_FIXTURE
    }

    public record InputMetadata(
            String name,
            List<Integer> shape,
            String tensorType,
            String featureLayoutVersion,
            String normalizationVersion,
            List<String> featureOrder) {

        private void validate() {
            if (!INPUT_NAME.equals(name)
                    || !INPUT_SHAPE.equals(shape)
                    || !TENSOR_TYPE.equals(tensorType)
                    || !FEATURE_LAYOUT_VERSION.equals(featureLayoutVersion)
                    || !NORMALIZATION_VERSION.equals(normalizationVersion)
                    || !FEATURE_ORDER.equals(featureOrder)) {
                throw invalidMetadata();
            }
        }
    }

    public record OutputMetadata(
            String name,
            List<Integer> shape,
            String tensorType,
            String semanticsVersion) {

        private void validate(int labelCount) {
            if (!OUTPUT_NAME.equals(name)
                    || shape == null || !shape.equals(List.of(1, labelCount))
                    || !TENSOR_TYPE.equals(tensorType)
                    || !OUTPUT_SEMANTICS.equals(semanticsVersion)) {
                throw invalidMetadata();
            }
        }
    }

    public record DecisionMetadata(Double minimumConfidence) {

        private void validate() {
            if (!isFinite(minimumConfidence)
                    || minimumConfidence <= 0.0 || minimumConfidence > 1.0) {
                throw invalidMetadata();
            }
        }
    }

    public record Label(Integer index, String id, String captionText, LabelOutcome outcome) {

        @Override
        public String toString() {
            return "Label[redacted]";
        }
    }

    public enum LabelOutcome {
        SIGN,
        NO_SIGN,
        REJECT
    }

    public record TrainingDatasetMetadata(
            String datasetId,
            String datasetVersion,
            String manifestPath,
            String manifestSha256,
            LicenceMetadata licence) {

        private void validate() {
            if (!matches(ENTITY_ID, datasetId)
                    || !matches(SEMANTIC_VERSION, datasetVersion)
                    || !matches(MANIFEST_PATH, manifestPath)
                    || !matches(SHA256, manifestSha256)
                    || licence == null) {
                throw invalidMetadata();
            }
            licence.validate();
        }
    }

    public record LicenceMetadata(
            String spdxExpression,
            Boolean commercialUseAllowed,
            Boolean redistributionAllowed) {

        private void validate() {
            if (spdxExpression == null || spdxExpression.length() < 2
                    || spdxExpression.length() > 128
                    || !SPDX_EXPRESSION.matcher(spdxExpression).matches()
                    || commercialUseAllowed == null || redistributionAllowed == null) {
                throw invalidMetadata();
            }
        }
    }

    public record EvaluationMetadata(
            EvaluationProtocolMetadata protocol,
            EvaluationMetricsMetadata metrics) {

        private void validate() {
            if (protocol == null || metrics == null) {
                throw invalidMetadata();
            }
            protocol.validate();
            metrics.validate();
        }
    }

    public record EvaluationProtocolMetadata(
            SplitStrategy splitStrategy,
            String splitSha256,
            Integer signerOverlapCount,
            Integer testSignerCount) {

        private void validate() {
            if (splitStrategy == null || !matches(SHA256, splitSha256)
                    || signerOverlapCount == null || signerOverlapCount < 0
                    || testSignerCount == null || testSignerCount < 0) {
                throw invalidMetadata();
            }
        }
    }

    public enum SplitStrategy {
        SIGNER_INDEPENDENT,
        RANDOM_SAMPLE,
        SYNTHETIC
    }

    public record EvaluationMetricsMetadata(
            Double macroF1,
            Double accuracy,
            Double falseFinalRate,
            Long sampleCount) {

        private void validate() {
            if (!isProbability(macroF1) || !isProbability(accuracy)
                    || !isProbability(falseFinalRate)
                    || sampleCount == null || sampleCount < 0) {
                throw invalidMetadata();
            }
        }
    }

    public record OnnxMetadata(
            String artifactPath,
            Integer opset,
            ParityMetadata parity) {

        private void validate() {
            if (!matches(ONNX_PATH, artifactPath)
                    || opset == null || opset < 17 || opset > 21
                    || parity == null) {
                throw invalidMetadata();
            }
            parity.validate();
        }
    }

    public record ParityMetadata(
            Boolean verified,
            Double absoluteTolerance,
            Double relativeTolerance,
            Double maxAbsoluteDifference) {

        private void validate() {
            if (verified == null
                    || !isFinite(absoluteTolerance)
                    || absoluteTolerance <= 0.0 || absoluteTolerance > 0.0001
                    || !isFinite(relativeTolerance)
                    || relativeTolerance <= 0.0 || relativeTolerance > 0.001
                    || !isFinite(maxAbsoluteDifference) || maxAbsoluteDifference < 0.0
                    || maxAbsoluteDifference > absoluteTolerance) {
                throw invalidMetadata();
            }
        }
    }

    public record RuntimeMetadata(
            String engine,
            String minimumVersion,
            List<String> executionProviders,
            Integer maxBatchSize,
            Double warmedP95LatencyMs) {

        private void validate() {
            if (!RUNTIME_ENGINE.equals(engine)
                    || !matches(RUNTIME_VERSION, minimumVersion)
                    || !List.of("CPUExecutionProvider").equals(executionProviders)
                    || maxBatchSize == null || maxBatchSize != 1
                    || !isFinite(warmedP95LatencyMs) || warmedP95LatencyMs < 0.0) {
                throw invalidMetadata();
            }
        }

        boolean isSatisfiedBy(String installedVersion) {
            if (!matches(RUNTIME_VERSION, installedVersion)) {
                return false;
            }
            String[] minimum = minimumVersion.split("\\.");
            String[] installed = installedVersion.split("\\.");
            for (int index = 0; index < minimum.length; index++) {
                int comparison = new BigInteger(installed[index])
                        .compareTo(new BigInteger(minimum[index]));
                if (comparison != 0) {
                    return comparison > 0;
                }
            }
            return true;
        }
    }

    public record SgslReviewMetadata(
            ReviewStatus status,
            String reviewerRole,
            List<String> reviewedLabelIds,
            String reviewArtifactSha256,
            String reviewedAt) {

        private void validate(Map<String, Label> labelsById) {
            if (status == null || !REVIEWER_ROLE.equals(reviewerRole)
                    || reviewedLabelIds == null
                    || reviewedLabelIds.size() != new HashSet<>(reviewedLabelIds).size()) {
                throw invalidMetadata();
            }
            for (String labelId : reviewedLabelIds) {
                Label label = labelsById.get(labelId);
                if (!matches(LABEL_ID, labelId)
                        || label == null || label.outcome() != LabelOutcome.SIGN) {
                    throw invalidMetadata();
                }
            }
            if (status == ReviewStatus.APPROVED) {
                if (reviewedLabelIds.isEmpty()
                        || !matches(SHA256, reviewArtifactSha256)
                        || !isTimestamp(reviewedAt)) {
                    throw invalidMetadata();
                }
            } else if (reviewArtifactSha256 != null || reviewedAt != null) {
                throw invalidMetadata();
            }
        }
    }

    public enum ReviewStatus {
        PENDING,
        APPROVED,
        REJECTED
    }

    public record GovernanceMetadata(
            Boolean allTrainingSamplesConsentVerified,
            Boolean usageRightsVerified,
            Boolean signerIndependentEvaluationVerified,
            Boolean rawVideoOrImageDataIncluded) {

        private void validate() {
            if (allTrainingSamplesConsentVerified == null || usageRightsVerified == null
                    || signerIndependentEvaluationVerified == null
                    || !Boolean.FALSE.equals(rawVideoOrImageDataIncluded)) {
                throw invalidMetadata();
            }
        }
    }

    public record ProductionPromotionMetadata(
            PromotionStatus status,
            String assessedAt,
            List<String> blockingReasons) {

        private void validate(ModelContract contract) {
            if (status == null || !isTimestamp(assessedAt) || blockingReasons == null
                    || blockingReasons.size() != new HashSet<>(blockingReasons).size()) {
                throw invalidMetadata();
            }
            for (String reason : blockingReasons) {
                if (reason == null || reason.isBlank() || reason.length() > 256) {
                    throw invalidMetadata();
                }
            }
            if (status == PromotionStatus.BLOCKED) {
                if (blockingReasons.isEmpty()) {
                    throw invalidMetadata();
                }
                return;
            }
            if (!blockingReasons.isEmpty()
                    || contract.mockModel()
                    || !contract.genuineSignLanguageData()
                    || contract.architecture().family() == ArchitectureFamily.SYNTHETIC_FIXTURE
                    || contract.evaluation().protocol().splitStrategy()
                    != SplitStrategy.SIGNER_INDEPENDENT
                    || contract.evaluation().protocol().signerOverlapCount() != 0
                    || contract.evaluation().protocol().testSignerCount() < 1
                    || contract.evaluation().metrics().macroF1() < 0.8
                    || contract.evaluation().metrics().falseFinalRate() > 0.05
                    || contract.evaluation().metrics().sampleCount() < 1
                    || !contract.onnx().parity().verified()
                    || contract.runtime().warmedP95LatencyMs() <= 0.0
                    || contract.runtime().warmedP95LatencyMs() > 500.0
                    || contract.sgslReview().status() != ReviewStatus.APPROVED
                    || !hasCompleteSignLabelReview(contract)
                    || !contract.governance().allTrainingSamplesConsentVerified()
                    || !contract.governance().usageRightsVerified()
                    || !contract.governance().signerIndependentEvaluationVerified()
                    || contract.governance().rawVideoOrImageDataIncluded()) {
                throw invalidMetadata();
            }
        }

        private static boolean hasCompleteSignLabelReview(ModelContract contract) {
            Set<String> reviewedLabelIds = new HashSet<>(
                    contract.sgslReview().reviewedLabelIds());
            return contract.labels().stream()
                    .filter(label -> label.outcome() == LabelOutcome.SIGN)
                    .map(Label::id)
                    .allMatch(reviewedLabelIds::contains);
        }
    }

    public enum PromotionStatus {
        BLOCKED,
        APPROVED
    }
}
