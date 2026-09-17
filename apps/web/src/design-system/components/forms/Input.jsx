import React from 'react';

export function Input({ label, placeholder, type = 'text', value, onChange, error, helpText, required = false }) {
  const [focus, setFocus] = React.useState(false);
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontFamily: 'var(--font-body)', maxWidth: 360 }}>
      {label && <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>{label}{required && <span style={{ color: 'var(--color-accent-dark)' }}> *</span>}</span>}
      <input
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={{
          fontFamily: 'var(--font-body)',
          fontSize: 15,
          padding: '10px 12px',
          borderRadius: 'var(--radius-md)',
          border: `1px solid ${error ? 'var(--color-danger)' : focus ? 'var(--color-primary)' : 'var(--border-default)'}`,
          background: 'var(--surface-card)',
          color: 'var(--color-ink)',
          outline: 'none',
          boxShadow: focus ? 'var(--shadow-focus)' : 'none',
          transition: 'border-color 150ms ease-out, box-shadow 150ms ease-out',
        }}
      />
      {error ? <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{error}</span> : helpText ? <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{helpText}</span> : null}
    </label>
  );
}
