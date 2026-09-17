import * as React from 'react';
export interface ToastProps {
  tone?: 'success' | 'info' | 'error';
  children: React.ReactNode;
  onDismiss?: () => void;
}

export function Toast(props: ToastProps): React.JSX.Element;
