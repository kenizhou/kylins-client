import { InjectedComponentSet } from '../plugins/InjectedComponentSet';

interface ToolWindowBarProps {
  position: 'left' | 'right' | 'bottom';
}

export function ToolWindowBar({ position }: ToolWindowBarProps) {
  const vertical = position === 'left' || position === 'right';
  return (
    <div
      className={`
        ${vertical ? 'w-11 flex-col' : 'h-11 flex-row'}
        flex items-center gap-1 pt-2 px-1 border-[var(--border)] bg-[var(--surface)]
        ${position === 'left' ? 'border-r' : ''}
        ${position === 'right' ? 'border-l' : ''}
        ${position === 'bottom' ? 'border-t' : ''}
      `}
    >
      <InjectedComponentSet role={`toolwindow:${position}`} containersRequired={false} />
    </div>
  );
}
