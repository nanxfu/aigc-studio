"""Dynamic styles coexist with acceleration and fail loudly on unsupported sources."""
import types
from unittest import mock
from support import DaemonUnitTest
from worker.inference.loaders.diffusers import SdxlLoraLoader, ZImageLoader, mount_style_lora, STYLE_LORA_ADAPTER, ACCEL_LORA_ADAPTER


class StyleLoraTest(DaemonUnitTest):
    def test_acceleration_and_style_are_both_active_before_placement(self):
        calls = []
        pipe = types.SimpleNamespace(
            load_lora_weights=lambda *args, **kwargs: calls.append(('load', args, kwargs)),
            set_adapters=lambda *args, **kwargs: calls.append(('activate', args, kwargs)),
        )
        loader = SdxlLoraLoader()
        with mock.patch('worker.inference.loaders.diffusers.from_pretrained_with_variant_fallback', return_value=pipe), \
             mock.patch.object(loader, '_base_kwargs', return_value={}), \
             mock.patch('worker.inference.loaders.diffusers.apply_scheduler'), \
             mock.patch.object(loader, '_place_pipe', side_effect=lambda value, *a, **k: calls.append(('place',)) or value), \
             mock.patch.dict('sys.modules', {'diffusers': types.SimpleNamespace(StableDiffusionXLPipeline=object)}):
            loader.construct({'lora': {'repo': 'accel/model', 'weight': 'a.safetensors'}, 'styleLora': {'repo': 'user/style', 'weight': 's.safetensors', 'scale': 0.6}}, source='base', local_lora_weight='/cache/a.safetensors', local_style_weight='/cache/s.safetensors')
        self.assertEqual(calls[0][2]['adapter_name'], ACCEL_LORA_ADAPTER)
        self.assertEqual(calls[1][2]['adapter_name'], STYLE_LORA_ADAPTER)
        self.assertEqual(calls[2][1][0], [ACCEL_LORA_ADAPTER, STYLE_LORA_ADAPTER])
        self.assertEqual(calls[2][2]['adapter_weights'], [1.0, 0.6])
        self.assertEqual(calls[-1], ('place',))

    def test_zimage_gguf_forwards_style_to_quantized_constructor(self):
        loader = ZImageLoader()
        with mock.patch.dict('sys.modules', {'diffusers': types.SimpleNamespace()}), mock.patch.object(loader, '_construct_gguf', return_value='pipe') as build:
            self.assertEqual(loader.construct({'quantization': {'scheme': 'gguf'}}, source='base', local_style_weight='/cache/style'), 'pipe')
        self.assertEqual(build.call_args.kwargs['local_style_weight'], '/cache/style')

    def test_local_assets_never_fall_back_to_hf_on_remote(self):
        with self.assertRaisesRegex(RuntimeError, 'local-gpu'):
            mount_style_lora(object(), {'styleLora': {'source': 'local', 'assetId': 'a' * 64}})

    def test_mount_failure_is_not_silently_ignored(self):
        with self.assertRaisesRegex(RuntimeError, '挂载失败'):
            mount_style_lora(object(), {'styleLora': {'repo': 'user/style', 'weight': 's.safetensors'}}, local_weight='/cache/style')
