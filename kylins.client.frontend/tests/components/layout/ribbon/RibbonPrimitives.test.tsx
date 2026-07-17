import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { RibbonButton, RibbonGroup } from '@/components/layout/ribbon/RibbonPrimitives';

describe('RibbonPrimitives', () => {
  it('renders a button with icon and label', () => {
    render(
      <RibbonGroup>
        <RibbonButton icon={<span data-testid="icon" />} onClick={() => {}}>
          Archive
        </RibbonButton>
      </RibbonGroup>,
    );
    expect(screen.getByRole('button', { name: /archive/i })).toBeInTheDocument();
  });

  it('does not import phosphor icons', () => {
    const file = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/components/layout/ribbon/RibbonPrimitives.tsx'),
      'utf8',
    );
    expect(file).not.toContain('@phosphor-icons');
  });
});
