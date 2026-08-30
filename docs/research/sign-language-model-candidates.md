# Sign-language model and dataset candidates

**Decision date:** 2026-08-30
**Scope:** Candidate evidence for SignConnect Milestones 3 and 4
**Product target:** CPU inference from a fixed 30-frame MediaPipe-derived feature window, exported to ONNX, for a small reviewed Singapore Sign Language (SgSL) isolated-sign vocabulary

## Executive decision

**No-go: do not import any reviewed dataset, checkpoint, or vocabulary as the production SgSL model.** None of the reviewed candidates combines all of the following:

- SgSL rather than another sign language;
- isolated-sign labels suitable for the intended five-sign proof;
- an explicit licence permitting the intended product use;
- signer-independent evaluation evidence;
- compatibility with SignConnect's MediaPipe sequence contract; and
- a first-party CPU ONNX artifact with measured parity and latency.

The SgSL Sign Bank and NTU learning materials are appropriate **reference and reviewer resources only**, subject to their rights and attribution terms. WLASL, ASL Citizen, and AUTSL are useful architecture and evaluation references, but their labels describe ASL or Turkish Sign Language, not SgSL. SignVerse-2M includes an SgSL language identifier, but its released supervision is automatically structured subtitle text over open-web video segments, not a reviewed isolated-sign SgSL benchmark, and its derived data is non-commercial. The small public SgSL prototype repository does not document a reusable licence, dataset provenance, signer-disjoint split, or community validation.

**Go:** continue Milestone 3 camera quality, calibration, segmentation, rejection, and deterministic contract work with synthetic/test fixtures. Build the Milestone 4 training, evaluation, ONNX export, and parity tooling so it is ready for approved data, but keep real-model readiness fail-closed until a promoted artifact satisfies the documented gates.

## Decision criteria

"Can power the product" means the asset can truthfully be used to label live output as SgSL without silently changing language, task, rights, or evaluation assumptions. A technically convertible PyTorch, TensorFlow, or Keras model is not considered ONNX-ready until an exported artifact passes numerical parity, Java ONNX Runtime loading, and warmed CPU latency checks in this repository.

Absence statements below are bounded to the first-party sources reviewed on 2026-08-30. "Not documented" does not claim that no unpublished artifact exists; it means SignConnect must not rely on one.

## Evidence matrix

| Candidate | Language and domain | Isolated or continuous | Input modality | Licence and commercial constraints | Signer-independent evidence | ONNX and CPU compatibility | Can truthfully power SignConnect? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **SADeaf / NTU SgSL Sign Bank** ([S1], [S2], [S3]) | SgSL community lexicon. Signs are gathered from Deaf participants; common variants are confirmed by a Deaf panel. | Published entries are individual sign references, although the collection process begins with signs produced in sentences. It is not a packaged recognition benchmark. | Web GIF/video demonstrations, descriptions, and linguistic parameters; no machine-learning tensor schema or checkpoint is documented. | SADeaf states that it owns the copyright; the site says all rights reserved. No training, derivative-model, redistribution, or commercial licence is documented. | Multiple-participant comparison and Deaf-panel confirmation support lexical validity, but there is no train/validation/test split or held-out-signer recognition result. | No model or ONNX artifact is documented. CPU inference is not applicable. | **No for training or deployment.** Use only to inform vocabulary discussion and review, unless SADeaf grants separate written rights. |
| **NTU _Singapore Sign Language: An Introduction_ e-book** ([S4]) | Introductory SgSL learning resource containing selected everyday signs and phrases. | Individual demonstrations inside an educational publication; not a dataset or recognition benchmark. | Text, figures, and more than 30 animated images. | The e-book is CC BY-NC-SA 4.0 except where noted. Images remain owned by their respective copyright owners, and the SgSL GIFs are credited to SADeaf. This does not provide a commercial training licence for the GIFs. | No model split or recognition evaluation. | No model or ONNX artifact. | **No.** It is a learning/reference publication, not deployable training data. |
| **NTU 2016 SgSL pilot corpus described by Lim** ([S5]) | SgSL narrative/classifier corpus: 4 h 32 min recorded from 14 participants with three cameras; 12 participants were analysed. | Continuous elicited narratives with ELAN-aligned translations, hand glosses, and classifier annotations; not an isolated five-sign benchmark. | Multi-view RGB video and linguistic annotation. | The thesis says participants consented to CC BY 4.0 release and describes the videos as open data. However, the reviewed primary source does not give a live corpus download endpoint, immutable version, checksum, or machine-readable manifest. Access and exact artifact provenance remain unresolved. | Multiple signers are present, but no signer-disjoint recognition split or model result is reported. | No recognition model or ONNX artifact. A substantial adapter and new isolated-sign annotation/evaluation design would be required. | **Not directly. Conditional research lead only.** Ask the corpus owner for the exact released artifacts and current terms before any access; do not infer availability from the thesis alone. |
| **Debby Ling `dzldebby/sgsl` prototype** ([S6], [S7]) | Author-described SgSL action-recognition prototype. | Small isolated/action sequence proof, not a documented community-reviewed vocabulary release. | OpenCV and MediaPipe features feeding a TensorFlow/Keras LSTM; repository contains a notebook and `finalmodel.h5`. | The first-party repository does not display a licence or dataset manifest. Training-data consent, redistribution rights, label provenance, and commercial use are not documented. | No signer-disjoint split or held-out-signer evidence is documented. | Keras H5, not ONNX. The author reports poor CPU frame rate; no Java ONNX Runtime parity or latency result is provided. | **No.** Useful as historical proof that MediaPipe/LSTM experimentation exists, not as a legally or scientifically promotable product artifact. |
| **WLASL and released baselines** ([S8], [S9]) | American Sign Language; 2,000 word-level glosses, 21,083 videos, 119 signers in WLASL2000. | Isolated/word-level. | Monocular RGB; first-party baselines include I3D plus 2D-pose GRU and Pose-TGCN implemented in PyTorch. | C-UDA; the official project explicitly limits data to academic/computational use and prohibits commercial use. | **No strict signer-disjoint benchmark.** The paper uses a 4:1:1 sample split and avoids placing repetitions of the same signer/sign instance across train and test, but it does not hold each test signer out from training across the vocabulary. | First-party releases document PyTorch checkpoints/training, not an ONNX artifact. The pose schema and 50-frame protocol differ from SignConnect; CPU suitability is unverified. | **No.** Wrong language and restrictive data terms. Use only as a research baseline/reference. |
| **ASL Citizen and baselines** ([S10], [S11], [S12], [S13]) | American Sign Language dictionary retrieval; 83,399 consented videos, 2,731 signs, 52 participants. | Isolated signs. | RGB I3D and a pose ST-GCN using 27 MediaPipe Holistic keypoints, with sequences capped at 128 frames. | Dataset use is licensed for research; Microsoft asks prospective commercial users to contact the project. The baseline code is MIT, but that code licence does not replace the dataset licence. | **Yes.** Published splits are participant-disjoint: 35 train, 6 validation, and 11 test users; validation/test users are unseen during training. | First-party PyTorch code and checkpoints are released, but no ONNX artifact is documented. Its 27-keypoint/up-to-128-frame representation is not SignConnect's 30-by-224 input. | **No for SgSL.** Strong reference for consent and signer-independent evaluation; labels and weights remain ASL-specific and dataset rights are research-scoped. |
| **AUTSL / ChaLearn and SAM-SLR** ([S14], [S15], [S16]) | Turkish Sign Language; 226 signs from 43 signers. | Isolated signs. | RGB and depth video plus Kinect skeleton; SAM-SLR also processes skeleton, flow, and depth-derived modalities. | Dataset download is governed by challenge terms and registration. The official SAM-SLR repository states that its code is for academic research and prohibits commercial use despite displaying a CC0 licence header with exceptions. | **Yes for the challenge split.** It uses 31 train, 6 validation, and 6 test signers. The AUTSL paper reports 62.02% for its user-independent baseline versus much higher random-split performance, demonstrating why signer separation matters. | First-party SAM-SLR materials use PyTorch 1.7, pretrained modality checkpoints, and a GPU Docker image; no ONNX artifact or CPU latency evidence is documented. Its modalities and shapes do not match SignConnect directly. | **No.** Wrong language, restrictive terms, and no verified CPU ONNX path. Use as signer-independent evaluation and multimodal architecture reference only. |
| **SignVerse-2M, including language code `sls`** ([S17], [S18]) | Multilingual open-web corpus with 55+ language identifiers, including `sls` for SgSL. Distribution is explicitly long-tailed. | Full videos segmented by subtitle timing; supervision is segment/document text, not manually reviewed isolated gloss boundaries. | DWPose at 24 FPS: 18 body, 21 left-hand, 21 right-hand, and 68 face points per frame, stored as `(x, y, score)`; raw RGB is not released. | Derived pose annotations and metadata are CC BY-NC 4.0. Original videos remain under source-platform terms and creator rights. Commercial product use is therefore not permitted by the dataset licence. | No signer identity split or held-out-signer SgSL recognition result is documented. Keypoints and subtitles are produced automatically, and the release cautions against claims of full linguistic coverage. | The first-party benchmark is a text-to-pose SignDW Transformer for generation. No isolated-sign recognition checkpoint, ONNX artifact, Java parity result, or CPU latency result is documented. Its DWPose schema is incompatible with the current MediaPipe input without a validated adapter. | **No.** An SgSL language code is not evidence of isolated, reviewed SgSL labels or deployable rights. It may inform non-commercial representation research only. |

## Cross-candidate findings

### Language cannot be relabelled

ASL, Turkish Sign Language, and SgSL are distinct linguistic targets. NTU describes SgSL as a local language shaped by Shanghainese Sign Language, ASL, Signing Exact English, and locally developed signs; that history does not make an ASL or AUTSL classifier an SgSL classifier ([S19]). Imported ASL/AUTSL checkpoints may be used only for clearly labelled engineering experiments, never for user-visible SgSL claims.

### Signer-independent evidence is a promotion requirement

ASL Citizen and the AUTSL challenge provide explicit participant-disjoint splits. WLASL's published 4:1:1 protocol is not signer-disjoint across the dataset. SignVerse and the local SgSL prototype do not document held-out-signer evaluation. A SignConnect model must freeze a signer-disjoint split before training and report per-class metrics, macro-F1, false-final rate, rejection behaviour, and results for signers never seen during fitting or threshold selection.

### Pose availability does not imply feature compatibility

The candidates use materially different representations: WLASL's OpenPose-based baselines select 50 frames, ASL Citizen uses 27 MediaPipe points and up to 128 frames, AUTSL/SAM-SLR uses Kinect and multi-stream features, and SignVerse uses 128 DWPose points at 24 FPS. None documents SignConnect's exact 30-frame, 224-feature normalization. Any reuse would require a versioned adapter plus training/evaluation through that exact adapter; silent reshaping or zero-filling is not acceptable evidence.

### Model format is not the deployment gate

The reviewed first-party materials release PyTorch or Keras checkpoints, or no model at all. Export feasibility is an engineering hypothesis, not proof of runtime fitness. Promotion requires deterministic Python-to-ONNX numerical parity, the same label/rejection decisions in Java ONNX Runtime, a fail-closed readiness check, and warmed CPU latency within the product budget.

## Required path to a genuine SgSL model

The recommended path is a small model trained specifically on SignConnect's exact feature contract, using consented multi-signer SgSL examples and an explicit `NO_SIGN`/negative class. A temporal convolutional network is the primary lightweight candidate, with a small GRU as the comparison baseline. This architecture choice remains provisional until evaluated on real approved data.

Before collection begins, approve a separate training-data boundary that defines:

1. the precise research/product purpose and whether commercial deployment is permitted;
2. informed consent text for raw video, derived landmarks, trained weights, publication, and future reuse;
3. retention, access control, encryption, export, deletion, withdrawal, and downstream-model invalidation procedures;
4. participant compensation and recruitment goals spanning multiple SgSL backgrounds, signing styles, handedness, skin tones, clothing, cameras, lighting, and mobility/access needs;
5. a pseudonymous manifest and signer-disjoint train/validation/test assignment fixed before training; and
6. a prohibition on treating live meeting traffic as training data.

Before labels or vocabulary are frozen, engage at least one compensated SgSL-fluent Deaf reviewer, preferably through a co-design relationship with the Singapore Deaf community. The reviewer must approve the intended five signs, acceptable variants, gloss/caption wording, collection prompts, exclusion criteria, and representative examples, then review ambiguity and failure cases before promotion. The Sign Bank can inform this work but cannot substitute for permission or reviewer judgement.

**Current blocker:** genuine SgSL collection and production-model promotion are blocked until the separate consent/data-governance decision is approved and an SgSL-fluent Deaf reviewer is engaged. This is an external evidence and governance blocker, not a reason to weaken the language claim, reuse live meeting data, scrape the Sign Bank, or relabel another sign language.

## Sources

All sources below were accessed on **2026-08-30**. Only first-party project pages, institutional materials, official repositories, and original papers were used.

- **[S1]** Singapore Association for the Deaf / NTU, _Singapore Sign Language Sign Bank_: https://blogs.ntu.edu.sg/sgslsignbank/
- **[S2]** Singapore Association for the Deaf / NTU, _SgSL Sign Bank FAQs_: https://blogs.ntu.edu.sg/sgslsignbank/faqs/
- **[S3]** Singapore Association for the Deaf, _Publications & Resources_ (Sign Bank ownership): https://sadeaf.org.sg/about-us/our-publications/
- **[S4]** Nanyang Technological University Library, _Singapore Sign Language: An Introduction_ (2024): https://ebook.ntu.edu.sg/sgsl-ebook
- **[S5]** Lim Jia Ying, _A Preliminary Examination of Classifiers in Singapore Sign Language_ (NTU final-year project, 2016): https://bond-lab.github.io/pdf/2016-fyp-lim-jia-ying.pdf
- **[S6]** Debby Ling, `dzldebby/sgsl` repository: https://github.com/dzldebby/sgsl
- **[S7]** Debby Ling, _Building a Singapore Sign Language (SgSL) recognition model with OpenCV and MediaPipe_: https://debby-ling.medium.com/building-a-singapore-sign-language-sgsl-recognition-model-with-opencv-and-mediapipe-7d8a36f35cbd
- **[S8]** WLASL official repository and licence notice: https://github.com/dxli94/WLASL/blob/master/index.md
- **[S9]** Li et al., _Word-level Deep Sign Language Recognition from Video: A New Large-scale Dataset and Methods Comparison_: https://arxiv.org/abs/1910.11006
- **[S10]** Microsoft Research, _ASL Citizen Datasheet_: https://www.microsoft.com/en-us/research/project/asl-citizen/datasheet/
- **[S11]** Microsoft Research, _ASL Citizen_ project and commercial-use contact: https://www.microsoft.com/en-us/research/project/asl-citizen/
- **[S12]** Desai et al., _ASL Citizen: A Community-Sourced Dataset for Advancing Isolated Sign Language Recognition_: https://papers.nips.cc/paper_files/paper/2023/hash/f29cf8f8b4996a4a453ef366cf496354-Abstract-Datasets_and_Benchmarks.html
- **[S13]** Microsoft, ASL Citizen baseline code and checkpoints: https://github.com/microsoft/ASL-citizen-code
- **[S14]** Sincan and Keles, _AUTSL: A Large Scale Multi-modal Turkish Sign Language Dataset and Baseline Methods_: https://arxiv.org/abs/2008.00932
- **[S15]** ChaLearn, _Large Scale Signer Independent Isolated SLR Dataset (CVPR 2021)_: https://chalearnlap.cvc.uab.es/dataset/40/description/
- **[S16]** Jiang et al., official SAM-SLR repository: https://github.com/jackyjsy/CVPR21Chal-SLR
- **[S17]** SignerX, _SignVerse-2M_ first-party dataset card: https://huggingface.co/datasets/SignerX/SignVerse-2M/blob/main/README.md
- **[S18]** Fang et al., _SignVerse-2M: A Two-Million-Clip Pose-Native Universe of 55+ Sign Languages_: https://arxiv.org/abs/2605.01720
- **[S19]** Nanyang Technological University Centre for Modern Languages, _Singapore Sign Language_: https://www.ntu.edu.sg/cml/languages/singapore-sign-language

## Method

The review checked five questions for every candidate: linguistic/task match, rights for the intended use, signer-independent evidence, exact input compatibility, and deployable artifact evidence. Where first-party documentation did not provide a split, licence, model format, or runtime measurement, the matrix records the evidence as missing rather than inferring permission or performance. No dataset or model was downloaded.
