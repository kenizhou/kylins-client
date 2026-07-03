import { useMemo } from 'react';
import { isProminent } from '../classificationStyle';
import type { ClassificationLevel } from '../classificationTypes';

export interface ClassificationWatermarkProps {
  level: ClassificationLevel | null | undefined;
  /** Identity stamped into the watermark (typically the account email). */
  identity?: string | null;
  /** Pre-formatted timestamp string. Avoids non-deterministic Date in this component. */
  timestamp?: string | null;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Diagonal, tiled, repeating watermark rendered as an absolutely-positioned
 * `pointer-events:none` overlay so clicks/scroll/typing pass through to the
 * content beneath (the sandboxed email iframe or the TipTap editor — neither of
 * which can host an overlay internally). Renders `null` for non-prominent levels.
 *
 * The parent must be `position: relative`.
 */
export function ClassificationWatermark({
  level,
  identity,
  timestamp,
}: ClassificationWatermarkProps) {
  const backgroundImage = useMemo(() => {
    if (!isProminent(level) || !level) return null;
    const parts = [level.name.toUpperCase()];
    if (identity) parts.push(identity);
    if (timestamp) parts.push(timestamp);
    const text = escapeXml(parts.join('  ·  '));
    // One tile holds a single rotated line; background-repeat tiles it across.
    const tileW = 360;
    const tileH = 200;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}" viewBox="0 0 ${tileW} ${tileH}">
      <text x="${tileW / 2}" y="${tileH / 2}" fill="${level.color}" fill-opacity="0.10"
        font-family="system-ui, sans-serif" font-size="16" font-weight="700"
        text-anchor="middle" dominant-baseline="middle"
        transform="rotate(-30 ${tileW / 2} ${tileH / 2})">${text}</text>
    </svg>`;
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  }, [level, identity, timestamp]);

  if (!backgroundImage) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-10"
      style={{ backgroundImage, backgroundRepeat: 'repeat' }}
    />
  );
}
