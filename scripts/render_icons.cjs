// Export application icons from the approved anime artwork (macOS sips).
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { copyFileSync } = require('node:fs');
const source = path.resolve(__dirname, '../docs/images/eir-icon-anime-source.png');
const output = path.resolve(__dirname, '../web/public');
for (const size of [32, 180, 192, 512, 1024]) {
  execFileSync('sips', ['-z', String(size), String(size), source, '--out', path.join(output, `icon-${size}.png`)], { stdio: 'ignore' });
  if (size !== 1024) copyFileSync(path.join(output, `icon-${size}.png`), path.join(output, `icon-anime-v1-${size}.png`));
}
