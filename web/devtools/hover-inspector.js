/**
 * 开发态「悬浮组件检查器」：按住 Alt 移动鼠标，实时框出光标下的元素，
 * 并在浮动提示里显示它所属的 React 组件链（从根组件到最近的叶子组件）。
 *
 * 定位：只用于排障，不参与生产构建。
 *  - 由 `web/main.jsx` 在 `import.meta.env.DEV` 分支里动态导入，构建产物里不会出现；
 *  - 不依赖 React DevTools，也不需要改 JSX 编译配置：直接读 DOM 节点上的 fiber 引用；
 *  - 浮层一律 `pointer-events: none`，不拦截正常点击；松开 Alt 立刻恢复原样；
 *  - Alt + 点击把组件链、fiber 与 props 打到控制台，方便继续往下查。
 *
 * 用法：`npm run dev` 打开工作台 → 按住 Alt → 鼠标划过界面；Alt + 点击打印详情。
 */

/** 重复安装守卫键：HMR 重跑模块时不叠加第二套浮层。 */
const INSTALL_KEY = '__AIGC_HOVER_INSPECTOR__'
/** 强调色：跟浏览器 DevTools 的选中高亮保持一致，避免和业务配色混淆。 */
const ACCENT = '#4c8dff'

/** 组件类型 → 可读名字（覆盖函数组件、类组件、memo、forwardRef、Context、lazy）。 */
function nameOfType(type) {
  if (!type) return ''
  if (typeof type === 'string') return type
  if (typeof type === 'function') return type.displayName || type.name || 'Anonymous'
  if (typeof type === 'object') {
    if (type.displayName) return type.displayName
    // forwardRef：真实组件在 render 上。
    if (type.render) return nameOfType(type.render)
    // memo：真实组件在 type 上。
    if (type.type) return nameOfType(type.type)
    // Context.Provider / Consumer：显示 Context 的 displayName。
    if (type._context) {
      const label = type._context.displayName || 'Context'
      return typeof type.$$typeof === 'symbol' ? label : `${label}.Provider`
    }
    if (type._result) return 'Lazy'
  }
  return ''
}

/** 从 DOM 节点取出 React fiber 引用（React 17+ 与旧版前缀都兼容）。 */
function fiberOf(node) {
  if (!node || node.nodeType !== 1) return null
  for (const key of Object.keys(node)) {
    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) return node[key]
  }
  return null
}

/** 沿 fiber.return 向上收集组件名，返回「根 → 叶」顺序的数组。 */
function componentChain(fiber) {
  const chain = []
  let node = fiber
  // 深度上限兜底：异常结构下不至于死循环。
  for (let depth = 0; node && depth < 80; depth += 1) {
    if (node.tag === 10) {
      // ContextProvider 的 type 是 context 对象本身，单独拼一个可读名字。
      const label = node.type?._context?.displayName
      if (label) chain.push(`${label}.Provider`)
    } else {
      const name = nameOfType(node.type)
      // 只保留真正的组件（函数 / 类 / memo / forwardRef），宿主标签单独一行展示。
      if (name && typeof node.type !== 'string' && !name.startsWith('_')) chain.push(name)
    }
    node = node.return
  }
  return chain.reverse()
}

/** DOM 元素摘要：`textarea#prompt.input.large`。 */
function describeElement(element) {
  const tag = element.tagName.toLowerCase()
  const id = element.id ? `#${element.id}` : ''
  const classes =
    typeof element.className === 'string'
      ? element.className
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 3)
          .map((name) => `.${name}`)
          .join('')
      : ''
  return `${tag}${id}${classes}`
}

export function installHoverInspector() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  if (window[INSTALL_KEY]) return window[INSTALL_KEY]

  const style = document.createElement('style')
  style.textContent = `
    #aigc-inspector-box {
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      border: 1px solid ${ACCENT};
      background: rgba(76, 141, 255, 0.14);
      box-sizing: border-box;
      display: none;
    }
    #aigc-inspector-tip {
      position: fixed;
      z-index: 2147483647;
      pointer-events: none;
      max-width: min(560px, calc(100vw - 24px));
      padding: 7px 10px 8px;
      border-radius: 7px;
      background: rgba(24, 27, 34, 0.95);
      color: #eef1f7;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.32);
      font: 12px/1.55 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif;
      display: none;
    }
    #aigc-inspector-tip .chain {
      color: #8ab6ff;
      font-weight: 600;
      word-break: break-word;
    }
    #aigc-inspector-tip .chain em {
      color: #6f7686;
      font-style: normal;
      font-weight: 400;
    }
    #aigc-inspector-tip .element {
      margin-top: 3px;
      display: flex;
      gap: 10px;
      justify-content: space-between;
      color: #cfd6e4;
      font-family: 'Cascadia Mono', 'SF Mono', Consolas, monospace;
      font-size: 11.5px;
    }
    #aigc-inspector-tip .size {
      color: #8d94a4;
      flex: none;
    }
    #aigc-inspector-tip .hint {
      margin-top: 4px;
      color: #737a8a;
      font-size: 11px;
    }
  `

  const box = document.createElement('div')
  box.id = 'aigc-inspector-box'

  const tip = document.createElement('div')
  tip.id = 'aigc-inspector-tip'
  tip.innerHTML =
    '<div class="chain"></div><div class="element"><span class="tag"></span><span class="size"></span></div>' +
    '<div class="hint">Alt + 点击 → 控制台输出组件链与 props</div>'
  const chainEl = tip.querySelector('.chain')
  const tagEl = tip.querySelector('.tag')
  const sizeEl = tip.querySelector('.size')

  document.head.appendChild(style)
  document.body.append(box, tip)

  let altDown = false
  let activeTarget = null
  let lastX = 0
  let lastY = 0
  let frame = 0

  const hide = () => {
    box.style.display = 'none'
    tip.style.display = 'none'
    activeTarget = null
  }

  /** 把浮层摆到光标右下方；贴近视口边缘时自动翻到反方向。 */
  const placeTip = (x, y) => {
    const margin = 12
    const rect = tip.getBoundingClientRect()
    let left = x + 16
    let top = y + 22
    if (left + rect.width + margin > window.innerWidth) left = Math.max(margin, x - rect.width - 16)
    if (top + rect.height + margin > window.innerHeight) top = Math.max(margin, y - rect.height - 22)
    tip.style.left = `${Math.round(left)}px`
    tip.style.top = `${Math.round(top)}px`
  }

  const updateAt = (x, y) => {
    // elementFromPoint 会跳过 pointer-events: none 的节点，浮层自身不会被选中。
    const element = document.elementFromPoint(x, y)
    if (!element || element === document.documentElement || element === document.body) {
      hide()
      return
    }

    if (element !== activeTarget) {
      activeTarget = element
      const chain = componentChain(fiberOf(element))
      chainEl.textContent = ''
      if (chain.length === 0) {
        const empty = document.createElement('em')
        empty.textContent = '（非 React 组件，或 fiber 不可用）'
        chainEl.appendChild(empty)
      } else {
        chain.forEach((name, index) => {
          if (index > 0) chainEl.append(' › ')
          chainEl.append(name)
        })
      }
      tagEl.textContent = describeElement(element)
    }

    const rect = element.getBoundingClientRect()
    box.style.display = 'block'
    box.style.left = `${Math.round(rect.left)}px`
    box.style.top = `${Math.round(rect.top)}px`
    box.style.width = `${Math.round(rect.width)}px`
    box.style.height = `${Math.round(rect.height)}px`

    sizeEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`
    tip.style.display = 'block'
    placeTip(x, y)
  }

  const onPointerMove = (event) => {
    lastX = event.clientX
    lastY = event.clientY
    if (!altDown || frame) return
    // 每帧最多算一次，避免鼠标高速移动时反复读 fiber 造成掉帧。
    frame = window.requestAnimationFrame(() => {
      frame = 0
      if (altDown) updateAt(lastX, lastY)
    })
  }

  const onScroll = () => {
    if (altDown) hide()
  }

  const onKeyDown = (event) => {
    if (event.key !== 'Alt' || altDown) return
    altDown = true
    // Alt 默认会激活窗口菜单（浏览器 / Electron 都是），这里只影响检查器自身状态。
    if (lastX || lastY) updateAt(lastX, lastY)
  }

  const onKeyUp = (event) => {
    if (event.key !== 'Alt') return
    altDown = false
    hide()
  }

  const resetAlt = () => {
    altDown = false
    hide()
  }

  /** Alt + 点击：拦截这一次点击，输出组件链 / fiber / props，避免误触业务按钮。 */
  const onPointerDown = (event) => {
    if (!event.altKey) return
    const element = document.elementFromPoint(event.clientX, event.clientY)
    if (!element) return
    event.preventDefault()
    event.stopPropagation()

    const fiber = fiberOf(element)
    const chain = componentChain(fiber)
    const label = chain.length ? chain[chain.length - 1] : describeElement(element)
    console.groupCollapsed(`%c[组件检查] ${chain.join(' › ') || label}`, `color: ${ACCENT}; font-weight: 600`)
    console.log('元素', element)
    console.log('组件链', chain)
    console.log('fiber', fiber)
    console.log('props', fiber?.memoizedProps)
    console.groupEnd()
  }

  window.addEventListener('pointermove', onPointerMove, { passive: true, capture: true })
  window.addEventListener('pointerdown', onPointerDown, { capture: true })
  window.addEventListener('keydown', onKeyDown, { capture: true })
  window.addEventListener('keyup', onKeyUp, { capture: true })
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
  window.addEventListener('blur', resetAlt)
  document.addEventListener('visibilitychange', resetAlt)

  const teardown = () => {
    window.removeEventListener('pointermove', onPointerMove, { capture: true })
    window.removeEventListener('pointerdown', onPointerDown, { capture: true })
    window.removeEventListener('keydown', onKeyDown, { capture: true })
    window.removeEventListener('keyup', onKeyUp, { capture: true })
    window.removeEventListener('scroll', onScroll, { capture: true })
    window.removeEventListener('blur', resetAlt)
    document.removeEventListener('visibilitychange', resetAlt)
    if (frame) window.cancelAnimationFrame(frame)
    box.remove()
    tip.remove()
    style.remove()
    delete window[INSTALL_KEY]
  }

  window[INSTALL_KEY] = { teardown, hide }
  return window[INSTALL_KEY]
}
