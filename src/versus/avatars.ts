/** Player skins: the same character in a different colour. Sent to the opponent when a match starts. */
export interface Avatar {
  name: string;
  tint: number;
  /** CSS colour for swatches. */
  css: string;
}

export const AVATARS: Avatar[] = [
  { name: 'DEFAULT', tint: 0xffffff, css: '#ffffff' },
  { name: 'EMBER', tint: 0xff8a5c, css: '#ff8a5c' },
  { name: 'FROST', tint: 0x8fd3ff, css: '#8fd3ff' },
  { name: 'TOXIC', tint: 0x9dff6a, css: '#9dff6a' },
  { name: 'VIOLET', tint: 0xc09bff, css: '#c09bff' },
  { name: 'GOLD', tint: 0xffd24a, css: '#ffd24a' },
  { name: 'ROSE', tint: 0xff8fc0, css: '#ff8fc0' },
  { name: 'SHADOW', tint: 0x7a7f99, css: '#7a7f99' },
];

export const avatarTint = (i: number): number => AVATARS[i]?.tint ?? 0xffffff;
