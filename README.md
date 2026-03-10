# SignConnect

## Recommended Tech Stack

### Frontend
- Next.js (TypeScript)
- React
- Tailwind CSS
- shadcn/ui
- WebRTC + WebSocket
- MediaPipe (client-side landmark extraction)

### Backend and Realtime
- FastAPI (Python) + Pydantic
- REST (control plane) + gRPC (internal low-latency service calls)
- FastAPI WebSocket gateway
- Redis (session state/cache)
- NATS JetStream (event bus)

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

## Proposed Monorepo File Structure

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
