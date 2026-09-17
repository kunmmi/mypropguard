import React from 'react';

export function Tabs({ items = [], value, onChange }) {
  return (
    <div style={{ fontFamily: 'var(--font-body)' }}>
      <div style={{ display: 'flex', gap: 24, borderBottom: '1px solid var(--border-default)' }}>
        {items.map((it) => {
          const active = it.value === value;
          return (
            <button key={it.value} onClick={() => onChange && onChange(it.value)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 2px', fontSize: 14, fontWeight: 600,
              color: active ? 'var(--color-primary)' : 'var(--text-muted)',
              borderBottom: active ? '2px solid var(--color-accent)' : '2px solid transparent',
              marginBottom: -1,
            }}>{it.label}</button>
          );
        })}
      </div>
    </div>
  );
}
