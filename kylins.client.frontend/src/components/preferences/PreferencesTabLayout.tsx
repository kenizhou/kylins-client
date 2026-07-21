import type { ReactNode } from 'react';

export function PreferencesTabLayout({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-6 p-6">{children}</div>;
}

export function PreferencesTabColumns({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-6 items-start">
      <div className="flex flex-col gap-6">{left}</div>
      <div className="flex flex-col gap-6">{right}</div>
    </div>
  );
}
