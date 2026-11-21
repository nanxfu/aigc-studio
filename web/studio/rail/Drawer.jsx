/**
 * 折叠区展开时的「抽屉」容器。
 *
 * 收起时子节点必须真的卸载（界面态持久化与测试都按「收起后不再渲染」判定），
 * 所以这里不做双向高度过渡，只在展开挂载的那一刻播一次 0fr → 1fr：内容按真实
 * 高度长出来，而不是整块跳出来；内层再落定 3px。动画结束停在 1fr，等于内容
 * 高度，之后内容长高（比如多一行建议）照常撑开。
 *
 * 只负责动效包装，不改变任何收起/展开的业务判定。
 */

import React from 'react'

import { usePresence } from '../hooks/usePresence.js'

/**
 * 判断所属面板是否已完成首屏挂载：只有用户在挂载后交互展开的抽屉才播展开动效，
 * 切换表单 ↔ 对话面板回到已展开状态时直接呈现，不重复从 0fr 跳开。
 */
export function useAnimateOpen() {
  const mountedRef = React.useRef(false)
  React.useEffect(() => {
    mountedRef.current = true
  }, [])
  return mountedRef.current
}

export function Drawer(props) {
  const hasOpenProp = 'open' in props
  const presence = usePresence(hasOpenProp ? props.open : true, 220)
  if (hasOpenProp && !presence.mounted) return null
  const staticClass = props.animate === false && !presence.exiting ? ' is-static' : ''
  const baseClass = `ofs-drawer${staticClass}`
  const className = props.className ? `${baseClass} ${props.className}` : baseClass
  return (
    <div className={className} data-exiting={presence.exiting ? 'true' : undefined}>
      <div className="ofs-drawer-inner">{props.children}</div>
    </div>
  )
}
