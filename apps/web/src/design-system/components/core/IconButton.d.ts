import * as React from 'react';

export interface IconButtonProps {
  /** Lucide icon name, e.g. "arrow-right" (icon set substituted, see readme ICONOGRAPHY). */
  icon: string;
  label: string;
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  disabled?: boolean;
}

export function IconButton(props: IconButtonProps): React.JSX.Element;
