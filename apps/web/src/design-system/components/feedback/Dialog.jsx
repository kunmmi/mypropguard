import React from 'react';

export function Dialog({ open, title, children, onClose }) {
  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(28,28,28,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, fontFamily: 'var(--font-body)' }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--surface-card)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-raised)',
        borderTop: '3px solid var(--border-accent)', padding: 'var(--space-6)', maxWidth: 420, width: '90%',
      }}>
        <h3 style={{ margin: '0 0 var(--space-3)', fontFamily: 'var(--font-display)', fontSize: 22 }}>{title}</h3>
        <div style={{ fontSize: 14, color: 'var(--text-muted)', lineHeight: 1.55, marginBottom: 'var(--space-5)' }}>{children}</div>
        <button onClick={onClose} style={{ background: 'var(--action-primary-bg)', color: '#fff', border: 'none', borderRadius: 'var(--radius-md)', padding: '9px 18px', fontWeight: 600, cursor: 'pointer' }}>Close</button>
      </div>
    </div>
  );
}
