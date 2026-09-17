import * as React from 'react';
export interface TagProps {
  children: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
}

export function Tag(props: TagProps): React.JSX.Element;
