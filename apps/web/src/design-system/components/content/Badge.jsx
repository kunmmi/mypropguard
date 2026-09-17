import React from 'react';

const tones = {
  primary: { bg: 'var(--color-primary)', fg: '#fff' },
  accent: { bg: 'var(--color-accent)', fg: '#1C1C1C' },
  neutral: { bg: 'var(--surface-sunken)', fg: 'var(--color-ink)' },
};

export function Badge({ tone = 'primary', children }) {
  const t = tones[tone] || tones.primary;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      background: t.bg, color: t.fg,
      fontFamily: 'var(--font-body)', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em',
      textTransform: 'uppercase', padding: '4px 9px', borderRadius: 'var(--radius-sm)',
    }}>{children}</span>
  );
}
