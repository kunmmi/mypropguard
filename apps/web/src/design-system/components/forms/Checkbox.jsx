import React from 'react';

export function Checkbox({ label, checked, onChange, disabled = false }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-ink)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      <span style={{
        width: 18, height: 18, borderRadius: 'var(--radius-sm)',
        border: `1px solid ${checked ? 'var(--color-primary)' : 'var(--border-default)'}`,
        background: checked ? 'var(--color-primary)' : 'var(--surface-card)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', transition: 'background-color 150ms ease-out',
      }}>
        {checked && <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M3 8.5L6.2 12L13 4" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      {label}
    </label>
  );
}
