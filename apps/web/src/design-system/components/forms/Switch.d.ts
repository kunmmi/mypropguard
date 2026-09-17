import * as React from 'react';
export interface SwitchProps {
  label: string;
  checked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}

export function Switch(props: SwitchProps): React.JSX.Element;
