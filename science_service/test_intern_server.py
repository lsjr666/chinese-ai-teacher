import unittest
from unittest.mock import patch

import science_service.intern_server as intern_server


PNG_1X1 = (
    "data:image/png;base64,"
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


class ScienceServerTests(unittest.TestCase):
    def test_extract_messages_splits_text_and_images(self):
        text, images = intern_server.extract_messages(
            [
                {"role": "system", "content": "你是中学科学老师。"},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "求物体加速度"},
                        {"type": "image_url", "image_url": {"url": PNG_1X1}},
                    ],
                },
            ]
        )

        self.assertIn("求物体加速度", text)
        self.assertIn("你是中学科学老师。", text)
        self.assertEqual(images, [PNG_1X1])

    def test_extract_messages_caps_the_number_of_images(self):
        blocks = [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{index}"}} for index in range(6)]
        _, images = intern_server.extract_messages([{"role": "user", "content": blocks}])

        self.assertEqual(len(images), intern_server.MAX_IMAGES)

    def test_decode_image_data_url_returns_rgb_image(self):
        image = intern_server.decode_image_data_url(PNG_1X1)

        self.assertEqual(image.mode, "RGB")
        self.assertGreaterEqual(image.width, 1)

    def test_decode_image_data_url_rejects_broken_payload(self):
        with self.assertRaises(ValueError):
            intern_server.decode_image_data_url("data:image/png;base64,not-a-real-image")

    def test_models_endpoint_reports_the_science_model(self):
        payload = intern_server.list_models()

        self.assertEqual(payload["data"][0]["id"], intern_server.MODEL_NAME)
        self.assertEqual(payload["data"][0]["object"], "model")

    def test_chat_completions_returns_openai_shape(self):
        captured = {}

        def fake_generate(prompt, image_urls):
            captured["prompt"] = prompt
            captured["images"] = list(image_urls)
            return '{"subject":"物理","answer":"a=F/m","steps":["由牛顿第二定律。"]}'

        with patch.object(intern_server, "generate_text", fake_generate):
            response = intern_server.chat_completions(
                intern_server.ChatRequest(
                    messages=[
                        {
                            "role": "user",
                            "content": [{"type": "text", "text": "求物体加速度"}],
                        }
                    ],
                )
            )

        message = response["choices"][0]["message"]
        self.assertEqual(message["role"], "assistant")
        self.assertIn("a=F/m", message["content"])
        self.assertEqual(captured["prompt"], "求物体加速度")
        self.assertEqual(captured["images"], [])

    def test_chat_completions_forwards_image_urls_to_the_model(self):
        captured = {}

        def fake_generate(prompt, image_urls):
            captured["images"] = list(image_urls)
            return "ok"

        with patch.object(intern_server, "generate_text", fake_generate):
            intern_server.chat_completions(
                intern_server.ChatRequest(
                    messages=[
                        {
                            "role": "user",
                            "content": [
                                {"type": "text", "text": "看这张受力图"},
                                {"type": "image_url", "image_url": {"url": PNG_1X1}},
                            ],
                        }
                    ],
                )
            )

        self.assertEqual(captured["images"], [PNG_1X1])

    def test_chat_completions_rejects_empty_content(self):
        with self.assertRaises(Exception):
            intern_server.chat_completions(intern_server.ChatRequest(messages=[]))

    def test_cpu_fallback_uses_bfloat16_instead_of_float32(self):
        """An 8B checkpoint in fp32 needs ~32 GB, which kills a 32 GB machine."""

        import torch

        with patch.dict("os.environ", {"SCIENCE_DTYPE": "auto"}, clear=False):
            dtype = intern_server._resolve_dtype(torch, "cpu")

        self.assertEqual(dtype, torch.bfloat16)

    def test_dtype_env_override_is_honoured(self):
        import torch

        with patch.dict("os.environ", {"SCIENCE_DTYPE": "float32"}, clear=False):
            self.assertEqual(intern_server._resolve_dtype(torch, "cpu"), torch.float32)

    def test_cuda_dtype_defaults_to_float16(self):
        import torch

        with patch.dict("os.environ", {"SCIENCE_DTYPE": "auto"}, clear=False):
            self.assertEqual(intern_server._resolve_dtype(torch, "cuda"), torch.float16)

    def test_device_falls_back_to_cpu_when_cuda_is_unavailable(self):
        class FakeCuda:
            @staticmethod
            def is_available():
                return False

        class FakeTorch:
            cuda = FakeCuda()

        with patch.dict("os.environ", {"SCIENCE_DEVICE": "auto"}, clear=False):
            self.assertEqual(intern_server._resolve_device(FakeTorch), "cpu")

    def test_explicit_cuda_without_cuda_raises_instead_of_silently_slowing_down(self):
        class FakeCuda:
            @staticmethod
            def is_available():
                return False

        class FakeTorch:
            cuda = FakeCuda()

        with patch.dict("os.environ", {"SCIENCE_DEVICE": "cuda"}, clear=False):
            with self.assertRaises(RuntimeError):
                intern_server._resolve_device(FakeTorch)

    def test_health_reports_dtype_quantization_and_missing_files(self):
        payload = intern_server.health()

        self.assertIn("dtype", payload)
        self.assertIn("quantized", payload)
        self.assertIn("missingFiles", payload)
        self.assertIsInstance(payload["available"], bool)


if __name__ == "__main__":
    unittest.main()
