---
version: 1
slug: "site-src-components-productdemo-astro"
primary_target: "site/src/components/ProductDemo.astro"
related_targets: ["site/src/data/product-demo.ts","site/src/scripts/product-demo.ts","site/src/styles/product-demo.css","site/src/views/HomeView.astro","site/PRODUCT-DEMO.md"]
---

# Product demonstration

Mode: Persuade. Extend the existing homepage with a maintainable, code-authored product demonstration immediately after the hero. The user explicitly requested a frontend UI shell and animations instead of screen recordings. Retain the existing homepage identity.

## Direction contract

THESIS: Let visitors follow one idea through the actual product's assistant, proposal, canvas, workshop and local collection. One shared DOM shell and three data-driven examples make future changes inexpensive.

OWN-WORLD: Inherit the site's darkroom/daylight colors and serif headings. The demonstration follows the selected website theme: charcoal workspace and light controls in darkroom, light gray workspace and ink controls in daylight. Preserve actual artwork colors, thin 1.6px icons and the prominent canvas.

STORY: Describe an idea, confirm the proposal, see the result, inspect or process it, find the deliverables locally. Entering inspect/process sweeps a `2×` lens across the current real output and fades back to the unobstructed artwork while the visitor compares the cutout or switches PBR channels. Use verified Botanica and shield outputs; identify the authored sequence and compressed waiting time. Credentials stay outside browser code.

FIRST VIEWPORT: A large readable product window follows the hero, before the image filmstrip. Three case tabs above it; five accessible stage controls, playback and replay beneath it. On phones, show readable controls and a full-width canvas rather than scaling a desktop screenshot.

FORM: seed: none (pinned). User: “在前端做个类似的UI壳，然后做动画就行”; later requested faster pacing, sticky narrative, and a visible high-resolution inspection. Code-led local extension. Automatic playback takes 12 seconds. On roomy desktop viewports, natural scrolling drives the same elapsed state while the workspace stays sticky; reverse scrolling revisits it. Stage clicks, confirmation, the detail lens, cutout comparison and PBR selection let the visitor take control. Pause timed playback offscreen and on hidden tabs. Reduced motion defaults to completion with manual steps, a static detail lens and no sticky scroll.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance. Existing global DESIGN.md is retained for this extension. Source provenance lives with the demo's data and documentation; no new generated rasters are required.
