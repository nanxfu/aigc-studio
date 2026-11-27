# Homepage product demonstration

The Chinese and English homepages share an animated product window directly below the hero. This is an authored frontend sequence with real output assets. It does not call inference services, read credentials, or write files from the browser.

## Preview and controls

Run `npm run dev` from `site`, then open `http://localhost:4321/#demo` or `http://localhost:4321/en/#demo`.

Choose a poster, a shield cutout, or PBR material extraction. Each example follows five stages: describe, confirm, generate, inspect/process, and keep locally. Stage buttons pause and seek; playback resumes from the selected point. The proposal's confirmation button advances to generation. During inspect/process, a `2×` detail lens enters, moves across the real output, holds briefly, then fades away. The poster also has a replayable “放大细节” control. The cutout slider and PBR channel buttons allow direct inspection and pause playback.

Automatic playback lasts 12 seconds, with the first image arriving after 4.7 seconds and waiting deliberately shortened. On desktop viewports at least 1060 × 800, the window stays visible during a short scroll story. Natural page scrolling advances or reverses the sequence; stage buttons jump to their point in the story. Auto play and the proposal confirmation switch to timed playback. Scrolling again takes control. Cutout and PBR controls pause for direct inspection. No wheel or touch events are intercepted.

When timed playback hands control back to scrolling, movement starts from the currently visible stage rather than the page's old scroll position. Small downward movements advance from that frame; upward movements rewind. The authored confirmation cursor is measured after the proposal layout settles so it targets the visible button.

Smaller viewports retain the compact automatic sequence and direct controls. Playback pauses when the window leaves the viewport or the tab becomes hidden. Reduced motion shows the completed result first without sticky scrolling and retains manual navigation. Without JavaScript, the completed poster and actual sample link remain available.

## Files to change

| File | Responsibility |
| --- | --- |
| `src/components/ProductDemo.astro` | Shared interface, accessible controls, completed HTML fallback |
| `src/components/DemoIcon.astro` | Consistent authored SVG icons |
| `src/data/product-demo.ts` | Examples, original prompts, parameters, image paths, bilingual copy, provenance and stage timing |
| `src/scripts/product-demo.ts` | One elapsed clock, derived states, playback, keyboard navigation and direct inspection |
| `src/styles/product-demo.css` | Product window, state transitions, both website themes and phone layout |
| `src/views/HomeView.astro` | Placement and the hero's workflow link |

Edit an example in `DEMO_CASES` and its corresponding `EN_CASE_COPY` entry. Static interface translations live in `DEMO_UI_EN`. PBR labels, filenames and image paths live in `PBR_CHANNELS`.

To replace an image, add the verified WebP to `public/assets/`, change its data path, and update its prompt, model, size, seed and evidence. Preserve alpha for cutouts. Use the same source across a processing example. The inspection lens reuses the current result layer; it magnifies the existing pixels and does not claim to run super-resolution. File and folder names shown inside the demonstration are illustrative.

Stage boundaries are defined by `DEMO_STAGES`. `DEMO_TIMELINE` defines typing, confirmation, image arrival, processing, channel changes and manual seek positions. Both timed and scroll playback derive the same elapsed state in `render()`. Update the data together when changing pacing. Avoid separate timeout chains that drift after pause or replay.

## Existing asset provenance

No new raster assets were generated for this addition.

| Asset | Verified source |
| --- | --- |
| `public/assets/showcase/qwen-image-2.1-botanica-poster.webp` | Qwen-Image 2.1, Colab L4, 768 × 1024, seed 202605; original prompt and 39.25-second inference record in `../docs/assets/showcase/manifest.json` |
| `public/assets/workshop/shield-source.webp` | SDXL Lightning, Kaggle 2×T4, 768 × 768, seed 42; `../bench-results/gpu-live/2026-11-23T15-36-01/01-workshop-source.png` |
| `public/assets/workshop/shield-cutout.webp` | Same source shield, historical BiRefNet result with real alpha; `02-cutout-birefnet.png` in the same run |
| `public/assets/workshop/shield-{albedo,normal,roughness,metallic}.webp` | Same source shield, actual Marigold four-step outputs; `03-pbr-{albedo,normal,roughness,metallic}.png` in the same run |

The GPU run's `report.json` provides the corresponding processing records. The cutout example does not identify the historical engine as the current product default. The Botanica example shows inspection and filing, without inventing a processed output.

## Design and validation

The surrounding section uses the website's existing darkroom/daylight tokens and serif heading. The product window follows the selected website theme too: charcoal panels and light actions in darkroom, light panels and ink actions in daylight. The artwork keeps its original colors, and the transparent checkerboard follows the theme. Layout and 1.6px icons follow the incumbent product in `../docs/DESIGN.md`. Phones receive a readable vertical composition rather than a scaled desktop window. Global design files remain unchanged.

Validate the mounted homepages with `npm run build`, then inspect all three examples in both languages. Check the five stages, confirmation, pause/replay, tab keyboard navigation, cutout comparison, PBR selection, reduced motion and the completed fallback. Use desktop, tablet and phone widths; long English proposals and the six-file PBR delivery are the most demanding states.
