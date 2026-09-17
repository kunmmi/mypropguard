import * as React from 'react';
export interface TabItem { label: string; value: string; }
export interface TabsProps {
  items: TabItem[];
  value: string;
  onChange?: (value: string) => void;
}

export function Tabs(props: TabsProps): React.JSX.Element;
