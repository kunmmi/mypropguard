import React from 'react';

export function Tooltip({ label, children }) {
  const [show, setShow] = React.useState(false);
  return (
    <span style={{ position: 'relative', display: 'inline-block' }} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <span style={{
          position: 'absolute', bottom: '125%', left: '50%', transform: 'translateX(-50%)',
          background: 'var(--color-ink)', color: '#fff', fontFamily: 'var(--font-body)',
          fontSize: 12, padding: '5px 9px', borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap', zIndex: 10,
        }}>{label}</span>
      )}
    </span>
  );
}
