import * as React from 'react';

export interface ButtonProps {
  /** Visual weight. Only one `primary` button should appear per view. */
  variant?: 'primary' | 'secondary' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function Button(props: ButtonProps): React.JSX.Element;
