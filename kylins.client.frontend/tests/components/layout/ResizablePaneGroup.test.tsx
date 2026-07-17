import { render, screen } from '@testing-library/react';
import { ResizablePaneGroup } from '@/components/layout/ResizablePaneGroup';

describe('ResizablePaneGroup', () => {
  it('renders visible panels', () => {
    render(
      <ResizablePaneGroup
        panels={[
          { id: 'a', content: <div>Panel A</div>, defaultSize: 30, minSize: 10 },
          { id: 'b', content: <div>Panel B</div>, defaultSize: 70, minSize: 10 },
        ]}
      />,
    );
    expect(screen.getByText('Panel A')).toBeInTheDocument();
    expect(screen.getByText('Panel B')).toBeInTheDocument();
  });

  it('skips hidden panels', () => {
    render(
      <ResizablePaneGroup
        panels={[
          { id: 'a', content: <div>Panel A</div>, defaultSize: 30, minSize: 10, visible: false },
          { id: 'b', content: <div>Panel B</div>, defaultSize: 70, minSize: 10 },
        ]}
      />,
    );
    expect(screen.queryByText('Panel A')).not.toBeInTheDocument();
    expect(screen.getByText('Panel B')).toBeInTheDocument();
  });

  it('wraps card panels in styled card', () => {
    const { container } = render(
      <ResizablePaneGroup
        panels={[
          { id: 'a', content: <div>Card content</div>, defaultSize: 100, minSize: 10, card: true },
        ]}
      />,
    );
    expect(container.querySelector('.rounded-xl.border')).toHaveTextContent('Card content');
  });
});
