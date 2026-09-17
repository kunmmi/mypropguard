import React from 'react';

export function Select({ label, options = [], value, onChange, placeholder = 'Select…' }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-body)', maxWidth: 360 }}>
      {label && <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>{label}</span>}
      <select
        value={value}
        onChange={onChange}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 15,
          padding: '10px 12px',
          borderRadius: 'var(--radius-md)',
          border: `1px solid ${focus ? 'var(--color-primary)' : 'var(--border-default)'}`,
          background: 'var(--surface-card)',
          color: 'var(--color-ink)',
          outline: 'none',
          boxShadow: focus ? 'var(--shadow-focus)' : 'none',
        }}
      >
        <option value="" disabled hidden>{placeholder}</option>
        {options.map((o) => (<option key={o.value} value={o.value}>{o.label}</option>))}
      </select>
    </label>
  );
}
