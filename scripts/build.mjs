import { cp, mkdir, rm } from 'node:fs/promises';

const files = [
  'index.html',
  'style.css',
  'app.js',
  'sw.js',
  'manifest.webmanifest',
  'privacy.html',
  'support.html',
  '.nojekyll',
  'icons'
];

await rm('www', { recursive: true, force: true });
await mkdir('www', { recursive: true });

for (const file of files) {
  await cp(file, `www/${file}`, { recursive: true });
}

console.log('Built static web assets in www/');
