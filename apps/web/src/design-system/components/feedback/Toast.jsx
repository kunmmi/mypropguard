import React from 'react';

const tones = {
  success: 'var(--color-success)',
  info: 'var(--color-primary)',
  error: 'var(--color-danger)',
};

export function Toast({ tone = 'info', children, onDismiss }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: 'var(--color-surface-dark)', color: '#fff',
      borderLeft: `3px solid ${tones[tone] || tones.info}`,
      borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-raised)',
      padding: '12px 16px', fontFamily: 'var(--font-body)', fontSize: 14, maxWidth: 360,
    }}>
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss && <button onClick={onDismiss} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,.6)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>}
    </div>
  );
}
