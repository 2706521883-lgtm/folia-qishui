#!/usr/bin/env node
// A packaged Electron window loads dist/index.html over file://. Any root-relative
// src/href ("/assets/…") resolves against the drive root instead of the app, so the
// renderer never boots and the splash screen stays up forever. Fail the build before
// electron-builder can package a web build.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const indexPath = resolve(process.cwd(), 'dist/index.html');
const html = readFileSync(indexPath, 'utf8');
const absolute = [...html.matchAll(/\b(?:src|href)="(\/[^"]*)"/g)].map(match => match[1]);

if (absolute.length > 0) {
    console.error('[verify-electron-dist] dist/index.html contains root-relative URLs:');
    for (const url of absolute) console.error(`  ${url}`);
    console.error('Build the Electron bundle with ELECTRON=true (npm run build:electron) before packaging.');
    process.exit(1);
}

console.log('[verify-electron-dist] ok: dist/index.html uses relative URLs');
