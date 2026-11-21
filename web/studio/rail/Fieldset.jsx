/**
 * 左栏（表单面板）通用的小节容器。
 *
 * 标题行是一道「版口标记」：组名 + 一条发丝线 + 本组读数。线从组名右侧起、到读数或
 * 箭头处收尾，所以它明确属于这一组的开头，而不是上一组的尾巴——因此面板里不再需要
 * 整幅分隔线，每一组由自己的标记起头。
 *
 * 可折叠的小节（排除项 / 高级设置）把整行做成开关：指针点哪都能开合，右侧箭头是真正
 * 的按钮（带 aria-expanded），读数在折叠态说明里面装的是什么。
 */

import React from 'react'

import { Icon } from '../icons.jsx'

export function Fieldset(props) {
  const { title, action, hint, toggle, open } = props
  // `toggle` 给了就是可折叠小节：标题行本身变成开关，箭头由这里统一追加在行尾。
  const collapsible = typeof toggle === 'function'

  return (
    <section className="ofs-fieldset">
      <div
        className={collapsible ? 'ofs-fieldset-head is-toggle' : 'ofs-fieldset-head'}
        // 整行可点只是指针层面的便利；键盘与读屏走右边那颗带 aria-expanded 的按钮。
        onClick={collapsible ? toggle : undefined}
      >
        {/* `hint` 是组名后面的小字注记（如「（可选）」）：始终可见，不靠 hover 才说得清。 */}
        <h3 className="ofs-fieldset-title">
          {title}
          {hint ? <span className="ofs-fieldset-hint">{hint}</span> : null}
        </h3>
        <span className="ofs-fieldset-rule" aria-hidden="true" />
        {action || null}
        {collapsible ? (
          <button
            type="button"
            className="ofs-fieldset-chevron"
            aria-expanded={open === true}
            aria-label={title}
            onClick={(event) => {
              if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
              toggle()
            }}
          >
            <Icon name="chevronDown" size={14} />
          </button>
        ) : null}
      </div>
      {props.children}
    </section>
  )
}
