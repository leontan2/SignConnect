import unittest

import numpy as np

from signconnect_ml.metrics import classification_metrics


class MetricsTest(unittest.TestCase):
    def test_explicit_reject_class_is_never_an_accepted_sign_and_measures_unknowns(self):
        result = classification_metrics(
            np.array(
                [
                    [0.0, 8.0, 0.0],
                    [0.0, 0.0, 8.0],
                    [0.0, 0.1, 0.0],
                ]
            ),
            np.array([1, 2, 2]),
            no_sign_index=0,
            false_final_threshold=0.8,
            unknown_mask=np.array([False, True, True]),
            reject_indices=(2,),
        )

        self.assertEqual(2, result.rejection.unknown_sample_count)
        self.assertEqual(1, result.rejection.accepted_sign_count)
        self.assertEqual(2, result.rejection.unknown_rejected_count)
        self.assertEqual(0, result.rejection.unknown_false_final_count)
        self.assertEqual(1.0, result.rejection.unknown_rejection_rate)

    def test_macro_f1_and_false_final_are_computed_from_no_sign_examples(self):
        logits = np.array(
            [
                [8.0, 0.0, 0.0],
                [0.0, 8.0, 0.0],
                [0.0, 0.0, 8.0],
                [0.0, 9.0, 0.0],
            ]
        )
        targets = np.array([0, 1, 2, 0])

        result = classification_metrics(logits, targets, no_sign_index=0, false_final_threshold=0.8)

        self.assertAlmostEqual(0.75, result.accuracy)
        self.assertEqual(1, result.false_final_count)
        self.assertEqual(2, result.no_sign_count)
        self.assertAlmostEqual(0.5, result.false_final_rate)
        self.assertAlmostEqual((2 / 3 + 2 / 3 + 1) / 3, result.macro_f1)
        self.assertEqual((1.0, 0.5, 1.0), result.per_class_precision)
        self.assertEqual((0.5, 1.0, 1.0), result.per_class_recall)
        self.assertEqual((2, 1, 1), result.per_class_support)
        self.assertEqual(((1, 1, 0), (0, 1, 0), (0, 0, 1)), result.confusion_matrix)

    def test_low_confidence_non_no_sign_prediction_is_not_a_false_final(self):
        result = classification_metrics(
            np.array([[0.0, 0.1, 0.0]]),
            np.array([0]),
            no_sign_index=0,
            false_final_threshold=0.8,
        )
        self.assertEqual(0, result.false_final_count)
        self.assertEqual(1, result.rejection.low_confidence_rejection_count)
        self.assertEqual(0, result.rejection.accepted_sign_count)
        self.assertEqual(0, result.rejection.no_sign_decision_count)
        self.assertAlmostEqual(1.0, result.rejection.rejection_rate)
        self.assertIsNone(result.rejection.accepted_sign_accuracy)

    def test_unknown_samples_report_rejection_and_false_final_behavior_separately(self):
        result = classification_metrics(
            np.array(
                [
                    [0.0, 8.0, 0.0],
                    [0.0, 0.1, 0.0],
                    [8.0, 0.0, 0.0],
                    [0.0, 8.0, 0.0],
                ]
            ),
            np.array([0, 0, 0, 1]),
            no_sign_index=0,
            false_final_threshold=0.8,
            unknown_mask=np.array([True, True, True, False]),
        )

        self.assertEqual(3, result.rejection.unknown_sample_count)
        self.assertEqual(2, result.rejection.unknown_rejected_count)
        self.assertEqual(1, result.rejection.unknown_false_final_count)
        self.assertAlmostEqual(2 / 3, result.rejection.unknown_rejection_rate)
        self.assertAlmostEqual(1 / 3, result.rejection.unknown_false_final_rate)
        self.assertEqual(0, result.no_sign_count)

    def test_unknown_mask_must_match_samples_and_be_boolean(self):
        logits = np.array([[1.0, 0.0], [0.0, 1.0]])
        targets = np.array([0, 1])
        for invalid in (np.array([True]), np.array([0, 1])):
            with self.subTest(mask=invalid):
                with self.assertRaisesRegex(ValueError, "unknown mask"):
                    classification_metrics(logits, targets, 0, 0.8, unknown_mask=invalid)


if __name__ == "__main__":
    unittest.main()
