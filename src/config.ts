/** Physical card proportions (classic trading card, 63 x 88 mm). */
export const CARD_ASPECT = 63 / 88;
/** Card height in world units (the table plane spans ~10 units vertically). */
export const CARD_H = 3.0;
export const CARD_W = CARD_H * CARD_ASPECT;
/** Clear plastic margin around the printed art, as a fraction of card width. */
export const CARD_MARGIN = 0.075;
/** Corner radius as a fraction of card width. */
export const CARD_RADIUS = 0.06;

const marginH = (CARD_MARGIN * CARD_W) / CARD_H;
/** Aspect (w/h) of the art window inside the card. */
export const ART_ASPECT = (1 - 2 * CARD_MARGIN) / (1 - 2 * marginH) * CARD_ASPECT;
/** Art rect inside card UV space: [u0, v0, u1, v1]. */
export const ART_RECT: [number, number, number, number] = [
  CARD_MARGIN,
  marginH,
  1 - CARD_MARGIN,
  1 - marginH,
];

/** Longest side of the processed art in pixels. */
export const ART_MAX_PX = 1024;
