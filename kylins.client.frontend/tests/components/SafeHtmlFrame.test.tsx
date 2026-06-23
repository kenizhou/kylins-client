import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SafeHtmlFrame } from '../../src/components/email/SafeHtmlFrame';

describe('SafeHtmlFrame', () => {
  it('renders an iframe', () => {
    const { container } = render(<SafeHtmlFrame html="<p>Hello</p>" />);
    expect(container.querySelector('iframe')).toBeInTheDocument();
  });

  it('does NOT have allow-same-origin in sandbox', () => {
    const { container } = render(<SafeHtmlFrame html="<p>Hello</p>" />);
    const iframe = container.querySelector('iframe');
    const sandbox = iframe?.getAttribute('sandbox');
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('has an empty sandbox attribute for strict isolation', () => {
    const { container } = render(<SafeHtmlFrame html="<p>Hello</p>" />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toHaveAttribute('sandbox', '');
  });

  it('has title "Message body"', () => {
    const { container } = render(<SafeHtmlFrame html="<p>Hello</p>" />);
    const iframe = container.querySelector('iframe');
    expect(iframe).toHaveAttribute('title', 'Message body');
  });

  it('strips script tags from the iframe body', () => {
    const { container } = render(
      <SafeHtmlFrame html="<p>Hello</p><script>alert('xss')</script>" />,
    );
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const body = iframe.contentDocument?.body;
    expect(body?.innerHTML).toContain('<p>Hello</p>');
    expect(body?.innerHTML).not.toContain('script');
  });

  it('adds target="_blank" and rel="noopener noreferrer" to links', () => {
    const { container } = render(<SafeHtmlFrame html='<a href="https://example.com">Link</a>' />);
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const body = iframe.contentDocument?.body;
    const link = body?.querySelector('a');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('resets iframe src to about:blank on unmount', () => {
    const { container, unmount } = render(<SafeHtmlFrame html="<p>Hello</p>" />);
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    unmount();
    expect(iframe.src).toBe('about:blank');
  });

  it('injects concrete theme styles into the iframe', () => {
    // Set CSS custom properties on the document root so getComputedStyle can read them
    document.documentElement.style.setProperty('--foreground', '#123456');
    document.documentElement.style.setProperty('--background', '#abcdef');
    document.documentElement.style.setProperty('--color-accent', '#ff00ff');

    const { container } = render(<SafeHtmlFrame html="<p>Styled</p>" />);
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const style = iframe.contentDocument?.querySelector('style');
    expect(style?.textContent).toContain('color: #123456');
    expect(style?.textContent).toContain('background: #abcdef');
    expect(style?.textContent).toContain('color: #ff00ff');

    // Cleanup
    document.documentElement.style.removeProperty('--foreground');
    document.documentElement.style.removeProperty('--background');
    document.documentElement.style.removeProperty('--color-accent');
  });
});
