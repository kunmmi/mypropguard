import * as React from 'react';
export interface RadioProps {
  label: string;
  name: string;
  checked?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
}

export function Radio(props: RadioProps): React.JSX.Element;
