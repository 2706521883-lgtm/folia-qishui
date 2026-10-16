// dev/we-scan-probe.cjs
// Read-only smoke check for the Wallpaper Engine library scan: runs the real main-process indexer
// against this machine's Steam install and prints the catalogue summary. Touches no wallpaper
// project (opens no window, sends no engine command), so it is safe to run any time.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { createWallpaperEngineLibrary } = require('../electron/wallpaperEngineLibrary.cjs');

const library = createWallpaperEngineLibrary({
    fs,
    path,
    execFile,
    logWarn: (label, detail) => console.warn('[warn]', label, detail || ''),
});

(async () => {
    const started = Date.now();
    const scan = await library.scan();
    const items = scan.items || [];
    const scenes = items.filter(item => item.type === 'scene');
    const playable = scenes.filter(item => item.enginePlayable);
    const withPreview = playable.filter(item => item.hasPreview !== false && item.previewFile);

    console.log('steam roots     :', (scan.steamRoots || []).join(' | ') || '(none)');
    console.log('library roots   :', (scan.libraryRoots || []).join(' | ') || '(none)');
    console.log('elapsed         :', Date.now() - started, 'ms');
    console.log('total projects  :', scan.total);
    console.log('by type         :', items.reduce((acc, item) => {
        acc[item.type] = (acc[item.type] || 0) + 1;
        return acc;
    }, {}));
    console.log('playable scenes :', playable.length);
    console.log('with preview    :', withPreview.length);
    console.log('with audio props:', playable.filter(item => item.audioPropertyCount > 0).length);
    console.log('--- first 8 playable ---');
    for (const item of playable.slice(0, 8)) {
        console.log([
            item.id,
            item.sourceKind,
            (item.audioPropertyCount + ' audio').padEnd(9),
            (item.hasPreview === false ? 'no-preview' : item.previewMimeType || 'no-preview').padEnd(12),
            (item.title || '').slice(0, 40),
        ].join('  '));
    }
    const target = playable.find(item => item.audioPropertyCount > 0) || playable[0];
    if (target) {
        const resolved = library.getItem(target.id);
        console.log('--- resolve by id ---');
        console.log('id      :', resolved && resolved.id);
        console.log('package :', resolved && resolved.scenePackageFile);
        console.log('header  :', resolved && resolved.scenePackageHeader);
        console.log('preview :', resolved && resolved.previewFile, '/', resolved && resolved.previewMimeType);
        console.log('mute    :', JSON.stringify(resolved && resolved.muteProperties));
        console.log('getItem(bogus):', library.getItem('bogus') ? 'LEAK' : 'null (ok)');
    }
})().catch(error => {
    console.error('probe failed:', error);
    process.exitCode = 1;
});
