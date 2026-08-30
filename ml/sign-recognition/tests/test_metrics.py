import unittest

import numpy as np

from signconnect_ml.metrics import classification_metrics


class MetricsTest(unittest.TestCase):
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

    def test_low_confidence_non_no_sign_prediction_is_not_a_false_final(self):
        result = classification_metrics(
            np.array([[0.0, 0.1, 0.0]]),
            np.array([0]),
            no_sign_index=0,
            false_final_threshold=0.8,
        )
        self.assertEqual(0, result.false_final_count)


if __name__ == "__main__":
    unittest.main()
