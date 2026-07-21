/**
 * Deterministic duotone avatar gradient derived from a name.
 *
 * Shared by the message list, message header, and contacts so the same person
 * always gets the same color identity. Fresh, airy treatment: a soft pastel
 * gradient with a saturated same-hue initial on top — reads light and clean
 * on both light and dark surfaces (Notion/Linear-style chips).
 *
 * The hash picks from a curated set of hues that stay pleasant in oklch — the
 * yellow/olive/lime band (~60–150°) is excluded on purpose: at pastel
 * lightness it reads muddy.
 */

/** Curated hue stops: teal → blue → iris → violet → magenta → pink → red. */
const AVATAR_HUES = [
  195, 210, 225, 240, 255, 268, 280, 292, 305, 318, 330, 342, 354, 8, 20,
] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export interface AvatarGradient {
  /** CSS background value (linear-gradient). */
  background: string;
  /** Readable foreground color to place on top of the gradient. */
  foreground: string;
}

export function avatarGradient(name: string): AvatarGradient {
  const hash = hashString(name);
  const hue = AVATAR_HUES[hash % AVATAR_HUES.length]!;
  const endHue = AVATAR_HUES[(hash + 2) % AVATAR_HUES.length]!;
  const background = `linear-gradient(135deg, oklch(0.86 0.07 ${hue}), oklch(0.74 0.11 ${endHue}))`;
  const foreground = `oklch(0.42 0.15 ${hue})`;
  return { background, foreground };
}
