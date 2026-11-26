---
version: 1
slug: "web-studio-onboarding"
primary_target: "web/studio/onboarding/Onboarding.jsx"
related_targets: ["web/studio/onboarding/OnboardingDemo.jsx", "web/studio/onboarding/OnboardingCompute.jsx", "web/styles/onboarding.css", "web/studio/Studio.jsx"]
---

# First-run setup

Mode: Operate. New full-page flow within the existing monochrome studio.

THESIS: Show the real creative workflow, connect one generation path with minimal decisions, then offer optional text-model assistance.

OWN-WORLD: Preserve docs/DESIGN.md, the studio surfaces, system type stack, outline icons, bilingual copy, and desktop window controls. No new raster assets or visual identity.

STORY: Explore translation, a scripted sequence of English prompt refinement and selected adjustments, and an Agent proposal that waits for confirmation before showing an example image. Actual refinement generates topic-specific suggestions that users can select and merge. Choose just one of Kaggle, Colab, local GPU, or an existing image API. Complete that path's browser authorization, automatic environment preparation, or key entry without starting a GPU instance. Built-in image API providers use a key with an optional endpoint override; a custom provider also needs its endpoint and model ID. Next optionally connect a text model. The parameter panel and a local Agent draft remain available without an LLM. Finish in the studio. Skip, revisit, and defer individual steps. Fresh installs show the guide until it is completed or skipped; existing installations keep normal startup.

FIRST VIEWPORT: Four-step progress, generous display type, unboxed feature choices, and staggered prompt fragments on an open canvas. A thin arc gives continuity without enclosing the demo. The source, tool action, output, refinements, and confirmed image are separate spatial moments. One primary action anchors the bottom. Normal motion plays once and supports pause/replay. Reduced motion reveals text and still waits for Agent confirmation.

FORM: Code-led, as requested: authored DOM/CSS animation, no recorded screenshots. Examples are marked as built-in demonstrations and make no API calls. Translation and refinement play predefined sequences; their output and adjustment marks are illustrative. Agent confirmation is interactive and advances the example only. Playback pauses when the page or demo is hidden and resumes when visible.

SURFACE TYPE: User explicitly requested bolder composition beyond rectangular cards. The first step uses 38–58px display type; later steps use 34–46px headings. Circular active marks, open paths, and an offset example print complete this composition. These are scoped to onboarding. The shared studio tokens and design files remain unchanged.

FINISH: Verify desktop 1440×900 and small PC window 1024×720, English and Chinese, light and dark, real save/error/skip behavior, Kaggle/Colab authorization states, selective compute configuration, Agent confirmation, persistence, upgrades, and reduced motion. Mobile is not a review target per the user. Raster reuse: existing web/studio/posters/inspire-4.webp, already used by ChatEmptyState, as an explicitly labeled synthetic example; no new raster file.
