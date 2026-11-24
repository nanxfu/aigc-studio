---
name: Imagen Studio Design System
description: '一间黑白灰的印相室：画布居中，控制件退到边缘的灰阶卡片里。'
colors:
  studio-ink: "#141416"
  ink-lift: "#2b2b30"
  ink-soft: "#3f3f46"
  ink-on: "#ffffff"
  ink-wash: "#f0f0f2"
  ink-wash-edge: "#dedee3"
  print-white: "#ffffff"
  frosted-shell: "rgb(255 255 255 / 86%)"
  ground-base: "#f5f5f6"
  ground-mist: "#f1f1f2"
  ground-shade: "#e7e8ea"
  ground-groove: "#e3e4e6"
  sunken-well: "#f4f4f6"
  sunken-edge: "rgb(18 18 22 / 8%)"
  hairline: "rgb(18 18 22 / 7%)"
  shell-edge: "rgb(18 18 22 / 8%)"
  panel-edge: "rgb(18 18 22 / 9%)"
  ink-secondary: "#52525a"
  ink-tertiary: "#6b6b73"
  ink-quaternary: "#a8a8b0"
  signal-ok: "#2f8a5c"
  signal-ok-wash: "#eaf5ef"
  signal-warn: "#a96a18"
  signal-warn-wash: "#f7f0e4"
  signal-error: "#c04444"
  signal-error-wash: "#f9ecec"
  signal-idle: "#a0a0a8"
  signal-idle-wash: "#f1f1f3"
typography:
  display:
    fontSize: "16px"
    fontWeight: 650
    lineHeight: 1.55
    letterSpacing: "0.01em"
  headline:
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  title:
    fontSize: "13.5px"
    fontWeight: 650
    lineHeight: 1.55
    letterSpacing: "0.02em"
  body:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontSize: "12.5px"
    fontWeight: 550
    lineHeight: 1.4
    letterSpacing: "0.01em"
  caption:
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.02em"
rounded:
  xl: "24px"
  lg: "18px"
  md: "14px"
  sm: "10px"
  input: "9px"
  action: "8px"
  micro: "6px"
  paper: "3px"
  pill: "999px"
spacing:
  pad: "18px"
  gap: "14px"
components:
  button-primary:
    backgroundColor: "{colors.studio-ink}"
    textColor: "{colors.ink-on}"
    rounded: "{rounded.md}"
    height: "42px"
    padding: "0 20px"
  button-secondary:
    backgroundColor: "{colors.print-white}"
    textColor: "{colors.studio-ink}"
    rounded: "{rounded.sm}"
    height: "38px"
    padding: "0 14px"
  generation-pipeline:
    backgroundColor: "{colors.print-white}"
    textColor: "{colors.studio-ink}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "0 12px"
  chip:
    backgroundColor: "{colors.print-white}"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.pill}"
    height: "28px"
    padding: "0 10px"
  input-field:
    backgroundColor: "{colors.sunken-well}"
    textColor: "{colors.studio-ink}"
    rounded: "{rounded.sm}"
    height: "34px"
    padding: "0 12px"
---

# UI 设计规范与系统设计令牌 (DESIGN)

<!-- impeccable:design-map -->
Name: Imagen Studio Design System
Colors: studio-ink #141416, ink-lift #2b2b30, ink-soft #3f3f46, ink-on #ffffff, ink-wash #f0f0f2, ink-wash-edge #dedee3, print-white #ffffff, frosted-shell rgb(255 255 255 / 86%), ground-base #f5f5f6, ground-mist #f1f1f2 (+18 more in the frontmatter)
Spacing: pad 18px, gap 14px
Radius: xl 24px, lg 18px, md 14px, sm 10px, input 9px, action 8px, micro 6px, paper 3px, pill 999px
North Star: "The Monochrome Print Room"
Elevation:
- Card (静止卡片)：0 1px 2px rgb(16 16 20 / 5%), 0 10px 24px -16px rgb(16 16 20 / 22%)
- Lift (悬浮抬升/Toast/弹出层)：0 2px 6px rgb(16 16 20 / 6%), 0 18px 40px -20px rgb(16 16 20 / 26%)
- Window (整页外壳)：0 1px 3px rgb(16 16 20 / 5%), 0 36px 80px -48px rgb(16 16 20 / 32%)
- Print (相纸)：0 20px 40px -24px rgb(16 16 20 / 42%), 0 4px 10px -6px rgb(16 16 20 / 18%)；悬停加深为 0 26px 50px -24px rgb(16 16 20 / 46%), 0 6px 14px -6px rgb(16 16 20 / 20%)，同时上移 2px。
- 纸边不用边框画：.ofs-print 用两层 0 模糊的环形阴影（0 0 0 11px paper + 0 0 0 12px edge）在图片外侧描出纸边，不占布局，任何画幅都不会把纸边挤歪。
- Focus Ring (键盘焦点)：0 0 0 2px var(--ofs-card-solid), 0 0 0 4px rgb(20 20 22 / 45%)
Don't:
- Don't 使用大面积彩色渐变、炫光或饱和彩色阴影。
- Don't 引入外部位图文件、字体包或 Emoji 符号作为系统图标；唯一例外是模型选择卡的 8 张 56×56 海报（112/96px WebP 构建期内联，base64 总量 ≤20KB）。
- Don't 在单屏视口内放置两个或以上的实心深色按钮。
- Don't 把光桌/相纸这套实物感扩散到其他界面：控制件一律扁平卡片，否则整页会变成一堆拟物盒子。
- Don't 破坏同心圆角规则导致内层切角外露或边距不协调（相纸等实物表面按 `paper (3px)` 处理）。
- Don't 把可折叠小节的标题做成纯标签：标题行就是开关，折叠态的读数是里面装了什么的唯一说明；也不要「卡片里再放一个带标题的折叠行」，那会出现两层箭头和一句重复的标签。
Do:
- Do 坚持以画面为主角，让所有控件与参数面板退守至边缘灰阶卡片中。
- (+6 more)
Full: .impeccable/design-full.md (read a section when you need its detail)
