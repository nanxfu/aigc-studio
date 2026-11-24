# Workshop examples

The shield and its processed outputs come from the successful Kaggle GPU run on
2026-11-23, recorded in `bench-results/gpu-live/2026-11-23T15-36-01/report.json`.

- Original: SDXL Lightning, seed 99, 768 × 768.
- Cutout: ZhengPeng7/BiRefNet, verified PNG with 47.08% fully transparent pixels.
- PBR: prs-eth/marigold-iid-appearance-v1-1, four sampling steps. The four images
  are the actual albedo, normal, roughness and metallic outputs.

The sword is a deterministic, locally authored game sprite. Its examples use the
same `snapPixelArt` and `sliceSpriteFrames` functions as the workshop. The tile
example repeats a patch of the shield before and after `blendSeamEdges`. The
vector example enlarges a small bitmap beside the actual VTracer spline result.
These are input/output examples, not promises of the result for another image.

Rebuild with `node tools/build-workshop-samples.mjs`. Rebuilding requires the
local GPU-run files, FFmpeg, and the project's dependencies. The committed WebP
and SVG files are sufficient to build and run the app without the GPU-run files.
