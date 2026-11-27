---
version: 1
slug: "web-studio-work-motion"
primary_target: "web/studio/Stage.jsx"
related_targets: ["web/studio/stage/Lightbox.jsx", "web/studio/Filmstrip.jsx", "web/studio/gallery/GalleryCard.jsx", "web/studio/workMotion.js", "web/studio/workshop/WorkshopStage.jsx", "web/studio/workshop/Workshop.jsx", "web/studio/hooks/useLatestPreview.js", "web/styles/stage.css", "web/styles/workshop.css"]
---

# 作品连续体验

Mode: Operate. Preserve the monochrome print room, green completion marks and #e6613e warnings.

THESIS: Keep one recognizable work continuous through viewing, enlargement, processing and arrival in the local collection.

USER DIRECTION: “ABC可以一起做” confirms image expansion/return, direct light/focus interaction and completed-work continuity together.

FORM: Code-led progressive enhancement. Native modal dialog and existing zoom/pan retain their behavior. Short image-position handoffs use cancellable WAAPI transforms. The filmstrip animates only visible new/moved cards. GPU preview remains separate from saving and passes canvases directly. Pointer updates coalesce by frame; one render runs at a time with the newest input next.

FINISH: Build and relevant client checks; Electron lightbox fit/zoom/pan/resize/Escape/focus regression; real Playwright interactions at 1440×900 and 1024×720, light/dark, reduced motion, rapid close, light dragging, focus selection, background completion and first-load-only development. Preview GPU fallback is tested without paid inference. No new shipping raster assets.
