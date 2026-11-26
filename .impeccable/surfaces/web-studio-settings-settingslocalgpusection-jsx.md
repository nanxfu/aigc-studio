---
version: 1
slug: "web-studio-settings-settingslocalgpusection-jsx"
primary_target: "web/studio/settings/SettingsLocalGpuSection.jsx"
related_targets: ["web/studio/settings/SettingsForm.jsx", "web/studio/settings/LocalModelStorageField.jsx", "web/styles/drawers.css", "web/studio/SettingsDrawer.jsx"]
---

# 本机 GPU 设置

Mode: Operate. Scope: distill the existing Local GPU settings surface.

## Direction contract

THESIS: Open settings and immediately understand the engine state, detected GPU, and model storage. Prepare the engine when needed.

OWN-WORLD: Preserve the monochrome studio, existing type, controls, settings dialog, and native folder picker. No new visual identity.

FIRST VIEWPORT: For every compute provider, collapse the six-provider chooser behind “更换算力” and show the selected provider name in the summary. Selecting another provider closes the chooser immediately and reveals its settings, preserving this behavior after saving and reopening. For Local GPU, a single flat panel shows engine status once, GPU name with its memory recommendation and suitability tier, inline detection, and the shared storage disclosure with disk usage.

DISCLOSURE: Changing compute shows only the existing grouped radio choices; provider settings and advanced controls are absent beneath the list. Clicking any provider, including the already-selected one, closes the list and enters its settings. A small green dot marks the saved current provider, with a tooltip and accessible label. The selected card border represents the draft choice; the dot moves only after a successful save. Opening storage reveals the existing directory editor, native folder picker where available, and reset action. The local-models tab keeps its expanded editor. Both continue to use the same API and immediate-save behavior.

STATES: Engine preparation, cancellation, known or unknown download size, retry, unsupported setup, unavailable hardware, and environment overrides remain visible when relevant. The dialog retains its existing save action for compute changes. Engine preparation uses a secondary button to avoid a second solid primary action.

VALIDATION: Inspect real browser renders at 1440×900 and 390×844, Chinese and English, light and dark, ready and preparation states. Exercise compute switching and storage persistence; run the existing client and locale checks and production build.

No shipping raster assets are introduced. Preview fixtures are illustrative and remain outside production.
