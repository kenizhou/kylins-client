import type { ReactNode } from 'react';

export function PreferencesTabLayout({ children }: { children: ReactNode }) {
  return <div className="p-6">{children}</div>;
}

export function PreferencesTabColumns({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
      <div className="space-y-5">{left}</div>
      <div className="space-y-5">{right}</div>
    </div>
  );
}
