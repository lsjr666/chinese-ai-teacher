import unittest
from unittest.mock import patch

import math_service.math_server as math_server


class MathServerRegressionTests(unittest.TestCase):
    def test_known_proof_prompt_requires_direct_inequalities(self):
        prompt = math_server.make_prompt(
            math_server.SolveRequest(problem="\u8bc1\u660e\uff1ae^x > ln x + 2")
        )

        self.assertIn("x > 0", prompt)
        self.assertIn("e^x > 1+x", prompt)
        self.assertIn("ln x <= x-1", prompt)
        self.assertIn("Do not replace a proof with finite-value testing", prompt)

    def test_generation_passes_attention_mask_and_uses_2048_tokens(self):
        class FakeTensor:
            shape = (1, 4)

            def __getitem__(self, item):
                return self

        class FakeTokenizer:
            eos_token_id = 0

            def apply_chat_template(self, *args, **kwargs):
                return {"input_ids": FakeTensor(), "attention_mask": FakeTensor()}

            def decode(self, *args, **kwargs):
                return "{}"

        class FakeModel:
            def __init__(self):
                self.kwargs = None

            def generate(self, inputs, **kwargs):
                self.kwargs = kwargs
                return [FakeTensor()]

        tokenizer = FakeTokenizer()
        model = FakeModel()
        with patch.object(math_server, "_tokenizer", tokenizer), patch.object(
            math_server, "_model", model
        ), patch.object(math_server, "MAX_NEW_TOKENS", 2048):
            math_server.generate_text("solve")

        self.assertIsNotNone(model.kwargs["attention_mask"])
        self.assertEqual(model.kwargs["max_new_tokens"], 2048)


if __name__ == "__main__":
    unittest.main()
