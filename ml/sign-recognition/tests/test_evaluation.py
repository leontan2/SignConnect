import unittest
from types import SimpleNamespace

import numpy as np

from signconnect_ml.evaluation import metrics_document
from signconnect_ml.metrics import classification_metrics


class EvaluationReportTest(unittest.TestCase):
    def test_report_serializes_indexed_class_metrics_confusion_and_rejection_evidence(self):
        metrics = classification_metrics(
            np.array(
                [
                    [8.0, 0.0, 0.0],
                    [0.0, 8.0, 0.0],
                    [0.0, 0.0, 8.0],
                    [0.0, 0.1, 0.0],
                ]
            ),
            np.array([0, 1, 2, 0]),
            no_sign_index=0,
            false_final_threshold=0.8,
            unknown_mask=np.array([False, False, False, True]),
        )
        manifest = SimpleNamespace(
            classes=("NO_SIGN", "HELLO", "HELP"),
            dataset_id="fixture-dataset",
            sha256="a" * 64,
            provenance_status="NON_PRODUCTION_SYNTHETIC",
        )

        report = metrics_document(metrics, manifest, "test")

        self.assertEqual(
            [
                {
                    "index": 0,
                    "labelId": "NO_SIGN",
                    "precision": 1.0,
                    "recall": 0.5,
                    "f1": 2 / 3,
                    "support": 2,
                },
                {
                    "index": 1,
                    "labelId": "HELLO",
                    "precision": 0.5,
                    "recall": 1.0,
                    "f1": 2 / 3,
                    "support": 1,
                },
                {
                    "index": 2,
                    "labelId": "HELP",
                    "precision": 1.0,
                    "recall": 1.0,
                    "f1": 1.0,
                    "support": 1,
                },
            ],
            report["metrics"]["perClass"],
        )
        self.assertEqual(
            {
                "labelOrder": ["NO_SIGN", "HELLO", "HELP"],
                "rows": [[1, 1, 0], [0, 1, 0], [0, 0, 1]],
            },
            report["metrics"]["confusionMatrix"],
        )
        self.assertEqual(0, report["metrics"]["noSignBehavior"]["falseFinalCount"])
        self.assertEqual(0.0, report["metrics"]["falseFinalRate"])
        self.assertEqual(1, report["metrics"]["rejectionBehavior"]["unknownSampleCount"])
        self.assertAlmostEqual(
            1.0,
            report["metrics"]["rejectionBehavior"]["unknownRejectionRate"],
        )


if __name__ == "__main__":
    unittest.main()
