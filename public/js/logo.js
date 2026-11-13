// BITE AND MELT mark: a burger with melting cheese. Colour version for the app, mono version for thermal printers.
const parts = (c) => `
<circle cx="50" cy="50" r="47" fill="${c.bg}" stroke="${c.ring}" stroke-width="${c.ringW}"/>
<path d="M24 46 Q24 22 50 22 Q76 22 76 46 Z" fill="${c.bun}"/>
<ellipse cx="40" cy="33" rx="2.6" ry="1.5" fill="${c.seed}"/><ellipse cx="52" cy="29" rx="2.6" ry="1.5" fill="${c.seed}"/><ellipse cx="62" cy="36" rx="2.6" ry="1.5" fill="${c.seed}"/>
<rect x="22" y="55" width="56" height="11" rx="5.5" fill="${c.patty}"/>
<path d="M21 47 H79 V51 Q79 55 75 55 H69 Q65 55 65 61 V69 Q65 73 62 73 Q59 73 59 69 V59 Q59 55 55 55 H25 Q21 55 21 51 Z" fill="${c.cheese}" stroke="${c.cheeseLine}" stroke-width="${c.cheeseW}"/>
<path d="M25 70 H75 Q75 79 67 79 H33 Q25 79 25 70 Z" fill="${c.bun}"/>`;
const svg = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="200" height="200">${parts(c)}</svg>`;

export const LOGO_COLOR = svg({ bg: '#4FC3F7', ring: '#ffffff', ringW: 2, bun: '#FFC72C', seed: '#fff7d6', patty: '#5b3a24', cheese: '#FFE680', cheeseLine: '#E0A800', cheeseW: 1 });
export const LOGO_MONO = svg({ bg: '#ffffff', ring: '#000000', ringW: 4, bun: '#000000', seed: '#ffffff', patty: '#000000', cheese: '#ffffff', cheeseLine: '#000000', cheeseW: 3 });
export const svgDataUrl = (s) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);

/** The official BITE AND MELT logo (public/brand/logo.png, or the logo uploaded in Settings). Never resized by CSS aspect: height is set, width follows.
 *  If no image is available the built-in mark is shown instead. */
export function brandLogo(cls = '', alt = 'BITE AND MELT') {
  const img = document.createElement('img');
  img.className = 'brand-logo ' + cls; img.alt = alt; img.decoding = 'async';
  img.onerror = () => { img.onerror = null; img.src = svgDataUrl(LOGO_COLOR); };
  img.src = '/brand/logo.png';
  return img;
}
