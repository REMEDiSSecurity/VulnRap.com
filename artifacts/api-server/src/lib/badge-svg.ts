export const BADGE_STYLES = ["default", "flat", "plastic", "social", "square"] as const;
export type BadgeStyle = typeof BADGE_STYLES[number];

interface RenderInput {
  label: string;
  value: string;
  color: string;
  style: BadgeStyle;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (/[A-Z0-9]/.test(ch)) w += 8;
    else if (/[a-z]/.test(ch)) w += 7;
    else if (ch === " ") w += 4;
    else w += 6;
  }
  return w;
}

export function renderBadgeSvg(input: RenderInput): string {
  const { label, value, color, style } = input;
  const labelText = escapeXml(label);
  const valueText = escapeXml(value);
  const padding = 12;
  const labelWidth = textWidth(label) + padding;
  const valueWidth = textWidth(value) + padding;
  const total = labelWidth + valueWidth;
  const labelBg = "#555";

  if (style === "social") {
    const h = 20;
    const w = total + 6;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" role="img" aria-label="${labelText}: ${valueText}">
  <linearGradient id="g" x2="0" y2="100%">
    <stop offset="0" stop-color="#fcfcfc" stop-opacity=".7"/>
    <stop offset="1" stop-color="#ccc" stop-opacity=".7"/>
  </linearGradient>
  <rect rx="3" width="${w - 1}" height="${h - 1}" fill="#fafafa" stroke="#d5d5d5"/>
  <rect x="${labelWidth - 1}" y="0" width="1" height="${h}" fill="#d5d5d5"/>
  <rect rx="3" width="${w - 1}" height="${h - 1}" fill="url(#g)"/>
  <g fill="#333" text-anchor="middle" font-family="Helvetica,Arial,sans-serif" font-weight="700" font-size="11">
    <text x="${labelWidth / 2}" y="14">${labelText}</text>
    <text x="${labelWidth + valueWidth / 2 + 3}" y="14" font-weight="400">${valueText}</text>
  </g>
</svg>`;
  }

  if (style === "square") {
    const h = 24;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${labelText}: ${valueText}">
  <rect width="${labelWidth}" height="${h}" fill="${labelBg}"/>
  <rect x="${labelWidth}" width="${valueWidth}" height="${h}" fill="${color}"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11" font-weight="600">
    <text x="${labelWidth / 2}" y="16">${labelText}</text>
    <text x="${labelWidth + valueWidth / 2}" y="16">${valueText}</text>
  </g>
</svg>`;
  }

  if (style === "plastic") {
    const h = 18;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${labelText}: ${valueText}">
  <linearGradient id="p" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".7"/>
    <stop offset=".1" stop-color="#aaa" stop-opacity=".1"/>
    <stop offset=".9" stop-color="#000" stop-opacity=".3"/>
    <stop offset="1" stop-color="#000" stop-opacity=".5"/>
  </linearGradient>
  <clipPath id="c"><rect width="${total}" height="${h}" rx="4" fill="#fff"/></clipPath>
  <g clip-path="url(#c)">
    <rect width="${labelWidth}" height="${h}" fill="${labelBg}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${h}" fill="${color}"/>
    <rect width="${total}" height="${h}" fill="url(#p)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="13" fill="#010101" fill-opacity=".3">${labelText}</text>
    <text x="${labelWidth / 2}" y="12">${labelText}</text>
    <text x="${labelWidth + valueWidth / 2}" y="13" fill="#010101" fill-opacity=".3">${valueText}</text>
    <text x="${labelWidth + valueWidth / 2}" y="12">${valueText}</text>
  </g>
</svg>`;
  }

  if (style === "flat") {
    const h = 20;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${labelText}: ${valueText}">
  <clipPath id="r"><rect width="${total}" height="${h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="${h}" fill="${labelBg}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${h}" fill="${color}"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${labelText}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${valueText}</text>
  </g>
</svg>`;
  }

  // default — Shields-style flat-square with subtle gradient
  const h = 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${labelText}: ${valueText}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="c"><rect width="${total}" height="${h}" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#c)">
    <rect width="${labelWidth}" height="${h}" fill="${labelBg}"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="${h}" fill="${color}"/>
    <rect width="${total}" height="${h}" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${labelText}</text>
    <text x="${labelWidth / 2}" y="14">${labelText}</text>
    <text x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${valueText}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${valueText}</text>
  </g>
</svg>`;
}
