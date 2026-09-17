import React from 'react';

const sizeStyles = {
  sm: { padding: '7px 14px', fontSize: 13 },
  md: { padding: '10px 20px', fontSize: 15 },
  lg: { padding: '13px 26px', fontSize: 16 },
};

const base = {
  fontFamily: 'var(--font-body)',
  fontWeight: 600,
  borderRadius: 'var(--radius-md)',
  border: '1px solid transparent',
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  transition: 'background-color 150ms ease-out, border-color 150ms ease-out, color 150ms ease-out',
};

const variants = {
  primary: {
    background: 'var(--action-primary-bg)',
    color: 'var(--action-primary-text)',
    borderColor: 'var(--action-primary-bg)',
  },
  secondary: {
    background: 'transparent',
    color: 'var(--action-secondary-text)',
    borderColor: 'var(--action-secondary-border)',
  },
  subtle: {
    background: 'var(--action-subtle-bg)',
    color: 'var(--action-subtle-text)',
    borderColor: 'transparent',
  },
};

const hoverBg = {
  primary: 'var(--action-primary-bg-hover)',
  secondary: 'var(--surface-sunken)',
  subtle: 'var(--color-tint)',
};

export function Button({ variant = 'primary', size = 'md', disabled = false, children, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  const v = variants[variant] || variants.primary;
  const s = sizeStyles[size] || sizeStyles.md;
  const computed = {
    ...base,
    ...s,
    ...v,
    opacity: disabled ? 0.45 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
    background: hover && !disabled && variant === 'primary' ? hoverBg.primary : v.background,
    ...style,
  };
  if (hover && !disabled && variant === 'secondary') computed.background = hoverBg.secondary;
  if (hover && !disabled && variant === 'subtle') computed.background = hoverBg.subtle;
  return (
    <button
      style={computed}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {children}
    </button>
  );
}
