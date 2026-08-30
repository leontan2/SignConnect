import importlib.util
import unittest


TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None


@unittest.skipUnless(TORCH_AVAILABLE, "PyTorch is not installed")
class ModelShapeTest(unittest.TestCase):
    def test_tcn_and_gru_map_fixed_sequence_contract_to_logits(self):
        import torch

        from signconnect_ml.models import build_model

        inputs = torch.zeros((2, 30, 224), dtype=torch.float32)
        for architecture in ("tcn", "gru"):
            with self.subTest(architecture=architecture):
                model = build_model(architecture, class_count=6, hidden_size=16, dropout=0.0)
                self.assertEqual((2, 6), tuple(model(inputs).shape))


if __name__ == "__main__":
    unittest.main()
