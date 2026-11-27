"""CPU-only check using the image's real diffusers/PEFT stack; no pretrained weights or GPU."""
import os
import sys
import tempfile

sys.path.insert(0, '/app/worker')
import numpy as np
import torch
from diffusers import ZImagePipeline, ZImageTransformer2DModel, AutoPipelineForImage2Image, AutoPipelineForInpainting, FlowMatchEulerDiscreteScheduler
from diffusers.quantizers.gguf.utils import GGUFLinear, GGUFParameter
from gguf import GGMLQuantizationType, quantize
from peft import LoraConfig
from peft.utils import get_peft_model_state_dict
from inference.loaders.diffusers import mount_style_lora, STYLE_LORA_ADAPTER


def model():
    return ZImageTransformer2DModel(dim=64, n_layers=1, n_refiner_layers=1, n_heads=2, n_kv_heads=2, cap_feat_dim=32, axes_dims=[8, 12, 12], axes_lens=[32, 32, 32])


with tempfile.TemporaryDirectory() as directory:
    source = model()
    source.add_adapter(LoraConfig(r=2, lora_alpha=2, target_modules=['to_q']), adapter_name='fixture')
    weights = get_peft_model_state_dict(source, adapter_name='fixture')
    ZImagePipeline.save_lora_weights(directory, transformer_lora_layers=weights, weight_name='style.safetensors')
    for quantized in (False, True):
        target = model()
        if quantized:
            for parent in list(target.modules()):
                for name, layer in list(parent.named_children()):
                    if name != 'to_q' or not isinstance(layer, torch.nn.Linear):
                        continue
                    replacement = GGUFLinear(layer.in_features, layer.out_features, bias=False, compute_dtype=torch.float32)
                    data = quantize(layer.weight.detach().numpy(), GGMLQuantizationType.Q8_0)
                    replacement.weight = GGUFParameter(torch.from_numpy(data), quant_type=GGMLQuantizationType.Q8_0)
                    parent._modules[name] = replacement
        pipe = ZImagePipeline(scheduler=FlowMatchEulerDiscreteScheduler(), vae=None, text_encoder=None, tokenizer=None, transformer=target)
        mount_style_lora(pipe, {'styleLora': {'repo': 'fixture/style', 'weight': 'style.safetensors', 'scale': 0.6}}, local_weight=os.path.join(directory, 'style.safetensors'))
        assert STYLE_LORA_ADAPTER in pipe.get_active_adapters()
        layers = [layer for layer in pipe.transformer.modules() if hasattr(layer, 'lora_A')]
        assert layers
        for layer in layers:
            output = layer(torch.randn(1, 2, layer.in_features))
            assert torch.isfinite(output).all()
            if quantized:
                assert isinstance(layer.base_layer, GGUFLinear), 'LoRA must preserve GGUF storage'
        for factory in (AutoPipelineForImage2Image, AutoPipelineForInpainting):
            derived = factory.from_pipe(pipe)
            assert derived.transformer is pipe.transformer
            assert STYLE_LORA_ADAPTER in derived.get_active_adapters()
        print(f'PASS Z-Image {"GGUF Q8" if quantized else "FP32"}: load style, scale, finite forward, img2img/inpaint adapter inheritance')
