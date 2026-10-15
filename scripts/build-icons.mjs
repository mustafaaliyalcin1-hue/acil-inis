// Generates the app icon + dark iOS splash screens (committed to public/).
import fs from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const plane = `
  <g transform="translate(250 210) rotate(16) scale(0.92)">
    <path d="M-150 0 C-150 -14 -128 -22 -96 -22 L120 -22 C150 -22 176 -10 182 0 C176 10 150 22 120 22 L-96 22 C-128 22 -150 14 -150 0 Z" fill="#f2f5f8"/>
    <path d="M-20 -18 L60 -18 L-40 -150 L-78 -150 Z" fill="#dfe5ec"/>
    <path d="M-20 18 L60 18 L-40 150 L-78 150 Z" fill="#c9d1da"/>
    <path d="M-150 -6 L-122 -6 L-160 -78 L-182 -78 Z" fill="#e8463a"/>
    <path d="M-140 -8 L-112 -8 L-150 -40 L-168 -40 Z" fill="#dfe5ec"/>
    <path d="M-140 8 L-112 8 L-150 40 L-168 40 Z" fill="#c9d1da"/>
    <rect x="-8" y="-64" width="46" height="18" rx="9" fill="#9aa6b2"/>
    <rect x="-8" y="46" width="46" height="18" rx="9" fill="#9aa6b2"/>
    <path d="M150 -8 L170 -8 L176 0 L170 8 L150 8 Z" fill="#203040"/>
  </g>`;
const runway = `
  <path d="M120 470 L392 470 L300 360 L212 360 Z" fill="#1d2633"/>
  <path d="M252 466 L260 466 L258 448 L254 448 Z M253 430 L259 430 L258 414 L254 414 Z M254 398 L258 398 L257.5 386 L254.5 386 Z" fill="#f4c542"/>
  <circle cx="132" cy="468" r="4" fill="#fff4b0"/><circle cx="380" cy="468" r="4" fill="#fff4b0"/>
  <circle cx="160" cy="434" r="3.4" fill="#fff4b0"/><circle cx="352" cy="434" r="3.4" fill="#fff4b0"/>
  <circle cx="186" cy="402" r="2.8" fill="#fff4b0"/><circle cx="326" cy="402" r="2.8" fill="#fff4b0"/>`;
function icon(pad = 0) {
  const s = 512 - pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#1b2a3d"/><stop offset="0.6" stop-color="#0b1320"/><stop offset="1" stop-color="#05080d"/></radialGradient>
    <radialGradient id="glow" cx="50%" cy="100%" r="60%"><stop offset="0" stop-color="#ff6a2b" stop-opacity="0.55"/><stop offset="1" stop-color="#ff6a2b" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(${pad} ${pad}) scale(${s / 512})">
    <rect width="512" height="512" fill="url(#glow)"/>
    ${runway}
    ${plane}
  </g>
</svg>`;
}
const render = (svg, w, out) => {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: w }, font: { loadSystemFonts: true } }).render().asPng();
  fs.writeFileSync(out, png);
};
fs.mkdirSync('public/icons', { recursive: true });
fs.mkdirSync('public/splash', { recursive: true });
render(icon(0), 192, 'public/icons/icon-192.png');
render(icon(0), 512, 'public/icons/icon-512.png');
render(icon(56), 512, 'public/icons/icon-maskable-512.png');
render(icon(0), 180, 'public/icons/apple-touch-icon.png');

const splashes = [[2796, 1290], [2556, 1179], [2532, 1170], [2778, 1284], [2436, 1125], [1792, 828], [2868, 1320], [2622, 1206]];
for (const [w, h] of splashes) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><radialGradient id="bg" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#132033"/><stop offset="1" stop-color="#05080d"/></radialGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#bg)"/>
    <g transform="translate(${w / 2 - h * 0.22} ${h * 0.16}) scale(${h * 0.44 / 512})">${plane}${runway}</g>
    <text x="${w / 2}" y="${h * 0.8}" fill="#e9eef4" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${h * 0.075}" text-anchor="middle" letter-spacing="${h * 0.012}">ACİL İNİŞ</text>
  </svg>`;
  render(svg, w, `public/splash/splash-${w}x${h}.png`);
}
console.log('icons + splash ok');
