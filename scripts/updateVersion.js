import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

try {
  const lastCommitTime = execSync('git log -1 --format=%ci')
    .toString()
    .trim()
    .split(' ')
    .slice(0, 2)
    .join(' ');

  const lastCommitHash = execSync('git log -1 --format=%h')
    .toString()
    .trim();

  const versionContent = `export const BUILD_TIME = "${lastCommitTime}";
export const COMMIT_HASH = "${lastCommitHash}";
`;

  const versionPath = path.join(__dirname, '../src/version.js');
  fs.writeFileSync(versionPath, versionContent);
  console.log('✅ version.js actualizado:', lastCommitTime, lastCommitHash);
} catch (err) {
  console.warn('⚠️ No se pudo generar version.js:', err.message);
  const fallbackContent = `export const BUILD_TIME = "${new Date().toISOString().slice(0, 19).replace('T', ' ')}";
export const COMMIT_HASH = "unknown";
`;
  const versionPath = path.join(__dirname, '../src/version.js');
  fs.writeFileSync(versionPath, fallbackContent);
}
