import React from 'react';

export function Radio({ label, name, checked, onChange, disabled = false }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-ink)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      <span style={{
        width: 18, height: 18, borderRadius: '50%',
        border: `1px solid ${checked ? 'var(--color-primary)' : 'var(--border-default)'}`,
        background: 'var(--surface-card)',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
      }}>
        {checked && <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--color-primary)' }} />}
      </span>
      <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      {label}
    </label>
  );
}
