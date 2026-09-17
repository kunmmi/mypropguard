import * as React from 'react';
export interface DialogProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose?: () => void;
}

export function Dialog(props: DialogProps): React.JSX.Element;
