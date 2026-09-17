import * as React from 'react';
export interface CardProps {
  title?: string;
  children: React.ReactNode;
  dark?: boolean;
}

export function Card(props: CardProps): React.JSX.Element;
