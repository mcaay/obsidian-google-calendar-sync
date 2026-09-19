import { cp, mkdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const folder = 'dist/google-daily-notes';
await rm(folder, { recursive: true, force: true });
await mkdir(folder, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'LICENSE']) {
    await cp(file, `${folder}/${file}`);
}
await cp('templates/Daily note.md', `${folder}/Daily note template.md`);
await rm('dist/google-daily-notes.zip', { force: true });
execFileSync('zip', ['-qr', 'google-daily-notes.zip', 'google-daily-notes'], { cwd: 'dist' });
console.log('Installable package: dist/google-daily-notes.zip');
