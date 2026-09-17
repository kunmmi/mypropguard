import React from 'react';

const sizePx = { sm: 32, md: 40, lg: 48 };

export function IconButton({ icon, label, variant = 'secondary', size = 'md', onClick, disabled = false }) {
  const [hover, setHover] = React.useState(false);
  const dim = sizePx[size] || sizePx.md;
  const isPrimary = variant === 'primary';
  const style = {
    width: dim,
    height: dim,
    borderRadius: 'var(--radius-md)',
    border: isPrimary ? 'none' : '1px solid var(--border-default)',
    background: isPrimary ? (hover ? 'var(--action-primary-bg-hover)' : 'var(--action-primary-bg)') : hover ? 'var(--surface-sunken)' : 'var(--surface-card)',
    color: isPrimary ? '#fff' : 'var(--color-ink)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    transition: 'background-color 150ms ease-out',
  };
  return (
    <button style={style} aria-label={label} title={label} disabled={disabled} onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <i data-lucide={icon} style={{ width: dim * 0.45, height: dim * 0.45 }}></i>
    </button>
  );
}
