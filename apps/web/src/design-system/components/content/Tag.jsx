import React from 'react';

export function Tag({ children, selected = false, onClick }) {
  return (
    <button onClick={onClick} style={{
      fontFamily: 'var(--font-body)', fontSize: 13, fontWeight: 600,
      padding: '6px 12px', borderRadius: 'var(--radius-sm)',
      border: `1px solid ${selected ? 'var(--color-primary)' : 'var(--border-default)'}`,
      background: selected ? 'var(--color-primary)' : 'var(--surface-card)',
      color: selected ? '#fff' : 'var(--color-ink)',
      cursor: onClick ? 'pointer' : 'default',
      transition: 'background-color 150ms ease-out, border-color 150ms ease-out',
    }}>{children}</button>
  );
}
