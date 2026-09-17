import React from 'react';

export function Switch({ label, checked, onChange, disabled = false }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, fontFamily: 'var(--font-body)', fontSize: 14, color: 'var(--color-ink)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      <span style={{
        width: 36, height: 20, borderRadius: 'var(--radius-full)',
        background: checked ? 'var(--color-primary)' : 'var(--border-default)',
        position: 'relative', flex: 'none', transition: 'background-color 150ms ease-out',
      }}>
        <span style={{ position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left 150ms ease-out', boxShadow: '0 1px 2px rgba(0,0,0,.25)' }} />
      </span>
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      {label}
    </label>
  );
}
