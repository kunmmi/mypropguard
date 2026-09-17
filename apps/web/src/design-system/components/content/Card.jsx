import React from 'react';

export function Card({ title, children, dark = false }) {
  return (
    <div style={{
      background: dark ? 'var(--surface-dark)' : 'var(--surface-card)',
      color: dark ? '#fff' : 'var(--color-ink)',
      borderTop: '3px solid var(--border-accent)',
      borderRadius: 'var(--radius-lg)',
      boxShadow: 'var(--shadow-card)',
      padding: 'var(--space-5)',
      fontFamily: 'var(--font-body)',
      maxWidth: 340,
    }}>
      {title && <h4 style={{ margin: '0 0 var(--space-2)', fontFamily: 'var(--font-display)', fontSize: 18, fontWeight: 700 }}>{title}</h4>}
      <div style={{ fontSize: 14, lineHeight: 1.55, color: dark ? 'rgba(255,255,255,.8)' : 'var(--text-muted)' }}>{children}</div>
    </div>
  );
}
