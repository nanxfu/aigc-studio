# Workshop examples

The shield and its processed outputs come from the successful Kaggle GPU run on
2026-11-23, recorded in `bench-results/gpu-live/2026-11-23T15-36-01/report.json`.

- Original: SDXL Lightning, seed 99, 768 × 768.
- Cutout: ZhengPeng7/BiRefNet, verified PNG with 47.08% fully transparent pixels.
- PBR: prs-eth/marigold-iid-appearance-v1-1, four sampling steps. The four images
  are the actual albedo, normal, roughness and metallic outputs.

The sword is a deterministic, locally authored game sprite. Its examples use the
same `snapPixelArt` and `sliceSpriteFrames` functions as the workshop. The vector
example enlarges a small bitmap beside the actual VTracer spline result.

The SVG tile guide repeats the same ribbon motif in a 2 × 2 grid, comparing a
crop with mismatched boundaries with one full repeat. The WebP tile assets
record a shield patch before and after `blendSeamEdges`.

Rebuild with `node tools/build-workshop-samples.mjs`. Rebuilding requires the
local GPU-run files, FFmpeg, and the project's dependencies. The committed WebP
and SVG files are sufficient to build and run the app without the GPU-run files.
