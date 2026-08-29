# SignConnect

SignConnect is a real-time accessibility workspace for sign-to-caption and speech-to-caption communication. The current implementation is the first end-to-end tracer slice: a React micro-frontend creates a meeting through Spring Boot and exchanges versioned caption events over WebSocket.

## Current Implementation

| Component | Technology | Port | Responsibility |
| --- | --- | ---: | --- |
| Shell MFE | React, TypeScript, Webpack Module Federation | 3000 | Product shell and navigation |
| Meeting MFE | React, TypeScript, Webpack Module Federation | 3001 | Camera, session state, and transcript UI |
| Meeting service | Spring Boot, Spring MVC | 8081 | Meeting creation and lifecycle |
| Realtime service | Spring Boot, WebFlux | 8082 | Recognizer input and caption WebSocket events |

The meeting workspace currently uses a clearly labelled recognizer simulator. Camera video stays in the browser and is not yet processed by a sign-language model.

## Run Locally

Prerequisites: Node.js 20+, npm 10+, and JDK 21.

Install and start the two frontend applications:

```powershell
npm install
npm run dev
```

Start each backend service in a separate terminal:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
cd backend
.\mvnw.cmd -pl meeting-service spring-boot:run
```

```powershell
$env:JAVA_HOME = 'C:\Program Files\Java\jdk-21'
cd backend
.\mvnw.cmd -pl realtime-service spring-boot:run
```

Open `http://localhost:3000`, select **Start session**, then use a recognizer simulator action to send a caption through the live WebSocket.

## Verify

```powershell
.\scripts\verify.ps1
```

The verification script runs both Spring service tests and production-builds both micro-frontends.

## Target Tech Stack

### Frontend
- React and TypeScript micro-frontends
- Webpack 5 Module Federation
- WebRTC and WebSocket
- MediaPipe (client-side landmark extraction)

### Backend and Realtime
- Spring Boot microservices on Java 21
- Spring MVC for the control plane and WebFlux for realtime streams
- REST, WebSocket, and gRPC for model-serving calls
- Redis (session state/cache)
- NATS JetStream for asynchronous events outside the live translation path

### AI/ML Inference
- Sign-to-text: PyTorch temporal model (Transformer/LSTM hybrid), served via ONNX Runtime/TensorRT
- Speech-to-text: Faster-Whisper (CTranslate2)
- Language refinement: fine-tuned T5/BART-style text refiner + domain phrase boosting
- Text-to-speech: Azure Speech SDK (primary), Piper/Coqui fallback

### Data and Storage
- PostgreSQL (multi-tenant app data)
- Redis (cache/realtime state)
- S3-compatible object storage (consented logs/model artifacts)
- ClickHouse (analytics)

### Auth and SaaS
- Keycloak (OIDC/SAML SSO, RBAC)
- Stripe (billing/subscriptions)

### Infrastructure and Ops
- Docker
- Kubernetes (AWS EKS in ap-southeast-1)
- Terraform
- Helm
- ArgoCD
- OpenTelemetry, Prometheus, Grafana, Loki, Tempo, Sentry

### MLOps
- DVC (dataset versioning)
- MLflow (experiment tracking)
- Label Studio (annotation)
- Triton/ONNX serving artifacts in registry

### Testing
- Pytest
- Jest
- Playwright
- k6 (latency/load)
- Security scanning in CI

## Future-State Monorepo Sketch

The structure below is a planning reference, not the current implementation. Components should be introduced only when a validated vertical slice requires them.

```text
SignConnect/
  README.md
  docs/
    architecture/
      system-overview.md
      realtime-sequence-sign-to-text.md
      realtime-sequence-speech-to-caption.md
      tenancy-and-privacy.md
    api/
      openapi.yaml
      grpc-contracts.md
    ml/
      model-card-sign2text.md
      evaluation-metrics.md
    adr/
      0001-monorepo.md
      0002-realtime-transport.md

  apps/
    web-client/
      src/
        app/
        components/
        features/
          captions/
          signer-input/
          speaker-input/
          settings/
        lib/
          webrtc/
          websocket/
          auth/
      public/
      tests/
      package.json
      next.config.ts
      tsconfig.json

    admin-portal/
      src/
        app/
        components/
        features/
          tenants/
          users/
          analytics/
      package.json

    zoom-integration/
      src/
      manifest.json
      package.json

    teams-integration/
      src/
      manifest/
      package.json

  services/
    api-gateway/
      app/
        main.py
        routers/
        auth/
        middleware/
      tests/
      pyproject.toml
      Dockerfile

    realtime-orchestrator/
      app/
        main.py
        session_manager.py
        pipeline_router.py
      tests/
      pyproject.toml
      Dockerfile

    sign-inference/
      app/
        main.py
        preprocess/
        models/
        inference/
      model_store/
      tests/
      pyproject.toml
      Dockerfile

    speech-to-text/
      app/
        main.py
        engines/
      tests/
      pyproject.toml
      Dockerfile

    language-refiner/
      app/
        main.py
        rules/
        domain_packs/
      tests/
      pyproject.toml
      Dockerfile

    text-to-speech/
      app/
        main.py
        providers/
      tests/
      pyproject.toml
      Dockerfile

    speech-to-sign-avatar/
      app/
        main.py
        renderer/
      tests/
      pyproject.toml
      Dockerfile

    consent-export/
      app/
        main.py
        jobs/
      tests/
      pyproject.toml
      Dockerfile

    billing/
      app/
        main.py
        stripe/
      tests/
      pyproject.toml
      Dockerfile

  packages/
    shared-types/
      src/
      package.json
    ui-kit/
      src/
      package.json
    sdk-js/
      src/
      package.json
    proto/
      realtime.proto
      inference.proto
      caption.proto

  ml/
    datasets/
      raw/
      processed/
      consented/
    labeling/
      guidelines.md
      label-studio-config/
    training/
      sign2text/
        configs/
        train.py
        evaluate.py
      language-refiner/
        configs/
        train.py
        evaluate.py
    inference/
      onnx/
      triton/
    experiments/
    notebooks/
    mlflow/

  infra/
    terraform/
      modules/
        network/
        eks/
        rds/
        redis/
        s3/
        iam/
      envs/
        dev/
        staging/
        prod/
    k8s/
      base/
      overlays/
        dev/
        staging/
        prod/
    helm/
      signconnect/
    observability/
      prometheus/
      grafana/
      loki/
      tempo/
    security/
      policies/
      threat-model.md

  data-contracts/
    events/
      translation.v1.json
      caption.v1.json
      session.v1.json

  tests/
    e2e/
    integration/
    contract/
    load/
      k6/
    security/

  scripts/
    bootstrap.ps1
    dev-up.ps1
    lint.ps1
    test.ps1
    seed_demo_data.py

  .github/
    workflows/
      ci-web.yml
      ci-services.yml
      ci-ml.yml
      cd-staging.yml
      cd-prod.yml

  docker-compose.local.yml
  .env.example
  .editorconfig
  .pre-commit-config.yaml
```
