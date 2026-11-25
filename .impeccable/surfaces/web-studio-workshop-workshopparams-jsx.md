---
version: 1
slug: "web-studio-workshop-workshopparams-jsx"
primary_target: "web/studio/workshop/WorkshopParams.jsx"
related_targets: ["web/studio/workshop/Workshop.jsx"]
---

# 工坊执行位置

Mode: Operate. Scope: existing workshop parameters, narrow extension.

## Direction contract

THESIS: PBR chooses a sensible default from detected hardware. Background removal runs automatically without asking the user to select compute.

OWN-WORLD: Preserve the existing monochrome studio, typography, spacing, and sliding segmented controls. Add no new visual identity.

STORY: A capable computer defaults to local PBR. The user can select cloud and that preference persists. Insufficient resources select cloud and disable local with a short explanation. Background removal has one action.

FIRST VIEWPORT: Put the Local / Cloud capsule first in the PBR parameter card, followed by one explanatory line, model, steps, and output channels. Preserve the canvas and existing primary action. The authored interaction is the existing sliding thumb; reduced motion follows the incumbent control.

FORM: seed: none (pinned). User request: “如果足够就优先本地跑，给个切换胶囊由用户决定是在云端还是本地跑”.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

Existing DESIGN.md remains the authority. No new shipping raster is created. Verify desktop, mobile, cloud-only, local-capable, and automatic background removal.
