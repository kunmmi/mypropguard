import * as React from 'react';
export interface BadgeProps {
  tone?: 'primary' | 'accent' | 'neutral';
  children: React.ReactNode;
}

export function Badge(props: BadgeProps): React.JSX.Element;
