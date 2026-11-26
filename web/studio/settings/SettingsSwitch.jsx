import React from 'react'

/** Settings share one visible switch, native keyboard behavior and accessible label. */
export function SettingsSwitch({ label, checked, disabled, onChange, onText, offText }) {
  return (
    <label className="ofs-settings-switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked === true} disabled={disabled} onChange={onChange} />
      <span className="ofs-switch-track" aria-hidden="true" />
      <span>{checked ? onText : offText}</span>
    </label>
  )
}
