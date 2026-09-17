import * as React from 'react';
export interface InputProps {
  label?: string;
  placeholder?: string;
  type?: 'text' | 'email' | 'url' | 'tel';
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  error?: string;
  helpText?: string;
  required?: boolean;
}

export function Input(props: InputProps): React.JSX.Element;
