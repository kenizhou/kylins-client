import { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

interface SafeHtmlFrameProps {
  html: string;
  className?: string;
}

function getThemeStyles(): string {
  const root = getComputedStyle(document.documentElement);
  const foreground = root.getPropertyValue('--foreground').trim();
  const background = root.getPropertyValue('--background').trim();
  const accent = root.getPropertyValue('--color-accent').trim();

  return `
    body {
      font-family: sans-serif;
      color: ${foreground || '#000'};
      background: ${background || '#fff'};
      margin: 0;
      padding: 16px;
    }
    img { max-width: 100%; height: auto; }
    a { color: ${accent || '#0066cc'}; }
  `;
}

export function SafeHtmlFrame({ html, className }: SafeHtmlFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentDocument) return;

    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        'p',
        'br',
        'a',
        'b',
        'i',
        'em',
        'strong',
        'ul',
        'ol',
        'li',
        'img',
        'div',
        'span',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
      ],
      ALLOWED_ATTR: ['href', 'title', 'alt', 'src'],
    });

    const doc = iframe.contentDocument;
    doc.open();
    doc.write(`
      <html>
        <head>
          <style>${getThemeStyles()}</style>
        </head>
        <body>${clean}</body>
      </html>
    `);
    doc.close();

    return () => {
      iframe.src = 'about:blank';
    };
  }, [html]);

  return (
    <iframe
      ref={iframeRef}
      sandbox=""
      className={className}
      style={{ width: '100%', height: '100%', border: 'none' }}
      title="Message body"
    />
  );
}
