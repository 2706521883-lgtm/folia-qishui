// dev/we-pkg-probe.cjs
// Read-only diagnostic: lists what a few real Scene projects actually contain, so the PKGV
// package-detection rule can be checked against the user's library instead of guessed.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');

const { resolveSteamLibraryRoots, normalizeWallpaperProjectType } = require('../electron/wallpaperEngineLibrary.cjs');

const readHead = async (file, bytes = 16) => {
    let handle = null;
    try {
        handle = await fsp.open(file, 'r');
        const buffer = Buffer.alloc(bytes);
        const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
        return buffer.subarray(0, bytesRead).toString('latin1').replace(/[^\x20-\x7e]/g, '.');
    } catch (error) {
        return '<' + error.code + '>';
    } finally {
        if (handle) await handle.close().catch(() => {});
    }
};

(async () => {
    const { libraryRoots } = await resolveSteamLibraryRoots({ fsp, path, execFile });
    const containers = libraryRoots.map(root => path.join(root, 'steamapps', 'workshop', 'content', '431960'));
    const seenScenes = [];
    for (const container of containers) {
        let entries = [];
        try {
            entries = await fsp.readdir(container, { withFileTypes: true });
        } catch { continue; }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(container, entry.name);
            let project = null;
            try {
                project = JSON.parse(await fsp.readFile(path.join(dir, 'project.json'), 'utf8'));
            } catch { continue; }
            if (normalizeWallpaperProjectType(project.type) !== 'scene') continue;
            seenScenes.push({ dir, project });
        }
    }

    console.log('scene projects found:', seenScenes.length);
    for (const { dir, project } of seenScenes.slice(0, 5)) {
        console.log('\n==', path.basename(dir), '|', (project.title || '').slice(0, 40));
        console.log('   declared file :', JSON.stringify(project.file), '| preview:', JSON.stringify(project.preview));
        let files = [];
        try { files = await fsp.readdir(dir); } catch { /* unreadable */ }
        for (const name of files) {
            const full = path.join(dir, name);
            const stats = await fsp.stat(full).catch(() => null);
            if (!stats || !stats.isFile()) continue;
            const head = ['pkg', 'pak', 'pkv'].includes(path.extname(name).slice(1).toLowerCase()) || stats.size > 1024 * 1024
                ? ' head=' + await readHead(full)
                : '';
            console.log('   -', name.padEnd(24), String(stats.size).padStart(10), head);
        }
    }
})().catch(error => {
    console.error('probe failed:', error);
    process.exitCode = 1;
});
