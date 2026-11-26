import React from 'react'

import { Icon } from '../icons.jsx'
import exampleImage from '../posters/inspire-4.webp'

export const DEMO_FEATURES = [
  { id: 'translate', icon: 'globe' },
  { id: 'polish', icon: 'sparkles' },
  { id: 'agent', icon: 'chat' },
]

/** An offline, authored sequence. No model requests or image jobs run in this preview. */
export function OnboardingDemo({ t, feature, reducedMotion }) {
  const demoRef = React.useRef(null)
  const [playing, setPlaying] = React.useState(!reducedMotion)
  const [visible, setVisible] = React.useState(true)
  const [elapsed, setElapsed] = React.useState(reducedMotion ? 9600 : 0)
  const [pageVisible, setPageVisible] = React.useState(() => typeof document === 'undefined' || !document.hidden)
  const [confirmed, setConfirmed] = React.useState(false)
  const duration = feature === 'translate' ? 9600 : 12800

  React.useEffect(() => {
    setElapsed(reducedMotion ? (feature === 'agent' ? 6800 : duration) : 0)
    setPlaying(!reducedMotion)
    setConfirmed(false)
  }, [feature, reducedMotion])

  React.useEffect(() => {
    const onVisibility = () => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.15 })
      : null
    if (demoRef.current) observer?.observe(demoRef.current)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      observer?.disconnect()
    }
  }, [])

  React.useEffect(() => {
    if (!playing || !visible || !pageVisible) return undefined
    let previous = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      const delta = Math.min(now - previous, 200)
      previous = now
      setElapsed((value) => Math.min(value + delta, duration))
    }, 80)
    return () => clearInterval(timer)
  }, [playing, visible, pageVisible, duration])

  React.useEffect(() => {
    if (elapsed >= duration || (feature === 'agent' && !confirmed && elapsed >= 6800)) setPlaying(false)
  }, [elapsed, duration, feature, confirmed])

  const output = feature === 'polish' && elapsed >= 8000 ? t('onboarding.demo.polish.merged') : t(`onboarding.demo.${feature}.output`)
  const phase = elapsed < 900 ? 'input' : elapsed < 1800 ? 'working' : 'output'
  const typed = reducedMotion ? output : output.slice(0, Math.ceil(output.length * Math.min(1, Math.max(0, elapsed - 1800) / 2600)))
  const agent = feature === 'agent'
  const polish = feature === 'polish'
  const awaitingConfirmation = agent && !confirmed && elapsed >= 6800

  function replay() {
    setConfirmed(false)
    setElapsed(reducedMotion ? (agent ? 6800 : duration) : 0)
    setPlaying(!reducedMotion)
  }

  return (
    <section ref={demoRef} className="ofs-onboarding-demo" aria-label={t('onboarding.demo.title')} data-feature={feature} data-phase={phase} data-playing={playing && visible && pageVisible ? 'true' : 'false'}>
      <svg className="ofs-onboarding-demo-orbit" viewBox="0 0 520 520" aria-hidden="true"><path d="M114 70a212 212 0 0 1 350 210M438 390A212 212 0 0 1 60 310" /><circle cx="464" cy="280" r="4" /><circle cx="60" cy="310" r="4" /></svg>
      <div className="ofs-onboarding-demo-canvas">
        <div className="ofs-onboarding-demo-source">
          <span className="ofs-onboarding-demo-label">{t(agent ? 'onboarding.demo.request' : 'onboarding.demo.original')}</span>
          <p>{t(`onboarding.demo.${feature}.input`)}</p>
        </div>
        <div className={`ofs-onboarding-demo-action${phase !== 'input' ? ' is-active' : ''}`}>
          <Icon name={agent ? 'chat' : 'sparkles'} size={16} />
          <span>{t(`onboarding.demo.${feature}.action`)}</span>
          <span className="ofs-onboarding-demo-cursor" aria-hidden="true"><Icon name="pointer" size={20} /></span>
          {phase === 'working' ? <span className="ofs-onboarding-demo-dots"><i /><i /><i /></span> : null}
        </div>
        <div className={`ofs-onboarding-demo-result${phase === 'output' ? ' is-visible' : ''}`}>
          <span className="ofs-onboarding-demo-label">{t(agent ? 'onboarding.demo.plan' : 'onboarding.demo.result')}</span>
          <p aria-hidden="true">{typed || '\u00a0'}{playing && phase === 'output' && elapsed < 4400 ? <span className="ofs-onboarding-demo-caret" /> : null}</p>
          {polish ? (
            <div className={`ofs-onboarding-demo-refinements${elapsed >= 4500 ? ' is-visible' : ''}`}>
              <div className="ofs-onboarding-demo-dimensions">
                {['light', 'material', 'composition', 'mood'].map((id, index) => <span key={id} className={(index === 0 || index === 2) && elapsed >= 6200 ? 'is-picked' : ''}><Icon name={(index === 0 || index === 2) && elapsed >= 6200 ? 'check' : 'plus'} size={12} />{t(`onboarding.demo.dimension.${id}`)}</span>)}
              </div>
              <div className={`ofs-onboarding-demo-merge${elapsed >= 8000 ? ' is-visible' : ''}`}><Icon name="compare" size={16} /><span>{t('onboarding.demo.polish.merge')}</span></div>
            </div>
          ) : null}
          {agent ? (
            <>
              <div className={`ofs-onboarding-demo-proposal${elapsed >= 4500 ? ' is-visible' : ''}`}>
                <span>SDXL Lightning</span><span>1024 × 1024</span><span>4 {t('onboarding.demo.steps')}</span>
                <button type="button" className="ofs-chip" disabled={elapsed < 6800 || confirmed} onClick={() => { setConfirmed(true); setElapsed(reducedMotion ? duration : 7200); setPlaying(!reducedMotion) }}>{t('onboarding.demo.agent.confirm')}<Icon name="chevronRight" size={14} /></button>
              </div>
              {awaitingConfirmation ? <p className="ofs-onboarding-demo-interact">{t('onboarding.demo.agent.try')}</p> : null}
              {confirmed ? <div className="ofs-onboarding-demo-generation" role="status"><Icon name={elapsed >= 10500 ? 'check' : 'clock'} size={14} />{t(elapsed >= 10500 ? 'onboarding.demo.agent.done' : 'onboarding.demo.agent.queue')}</div> : null}
              <figure className={`ofs-onboarding-demo-image${confirmed && elapsed >= 10500 ? ' is-visible' : ''}`}>
                <img src={exampleImage} alt={t('onboarding.demo.agent.imageAlt')} /><figcaption>{t('onboarding.demo.agent.imageCaption')}</figcaption>
              </figure>
            </>
          ) : <div className="ofs-onboarding-demo-result-note"><Icon name="check" size={14} />{t(`onboarding.demo.${feature}.note`)}</div>}
        </div>
      </div>
      <p className="ofs-onboarding-sr" role="status">{phase === 'output' ? output : t(`onboarding.demo.${feature}.input`)}</p>
      <footer className="ofs-onboarding-demo-footer">
        <span>{t('onboarding.demo.offline')}</span>
        <div>
          <button type="button" disabled={awaitingConfirmation} onClick={() => { if (elapsed >= duration) { replay(); return }; setPlaying((value) => !value) }} aria-label={t(playing ? 'onboarding.demo.pause' : 'onboarding.demo.play')}>
            <svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              {playing ? <path d="M7 4v12M13 4v12" /> : <path d="m6 3 10 7-10 7z" />}
            </svg>
          </button>
          <button type="button" onClick={replay} aria-label={t('onboarding.demo.replay')}><Icon name="refresh" size={14} /></button>
        </div>
      </footer>
    </section>
  )
}
