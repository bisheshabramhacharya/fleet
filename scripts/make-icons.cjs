// Renders the fleet icon SVGs to PNGs with a local Chrome (dev-time only).
const path = require("node:path");
const { chromium } = require("playwright-core");
const root = path.dirname(__dirname);
const glyph = (stroke, width) => `<path d="M6 16.5 9.5 9l3 5 2-3.2L18 16.5" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
const app = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#26272b"/><stop offset="1" stop-color="#0b0b0c"/></linearGradient></defs><rect x="1" y="1" width="22" height="22" rx="5.2" fill="url(#g)" stroke="#ffffff22" stroke-width="0.3"/>${glyph("#f2b84b", 1.9)}</svg>`;
const tray = (color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="3 3 18 18">${glyph(color, 2.4)}</svg>`;
const jobs = [
  ["icon.png", app, 1024],
  ["tray.png", tray("#ffffff"), 16],
  ["tray@2x.png", tray("#ffffff"), 32],
  ["trayTemplate.png", tray("#000000"), 16],
  ["trayTemplate@2x.png", tray("#000000"), 32],
];
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME });
  const page = await browser.newPage();
  for (const [file, svg, size] of jobs) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
    await page.screenshot({ path: path.join(root, "build", file), omitBackground: true });
  }
  await browser.close();
  console.log("icons written");
})();
