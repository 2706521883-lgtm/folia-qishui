// electron/wallpaperEngineLibrary.cjs
// Local Wallpaper Engine library discovery: Steam roots → workshop/431960 + myprojects →
// project.json index, scene-package (PKGV) validation and scene audio-property heuristics.
//
// Ported from Mineradio (GPL-3.0-only) desktop/wallpaper-engine-library.js
//   revision d43de565acabfdc1a9c9820a27e81a98ccbebcef — the Steam container discovery order, the
//   scene-property audio heuristics (AUDIO_PROPERTY_* / deriveSceneMuteProperties) and the PKGV
//   header check. Folia reads the same local metadata and mutates nothing on disk.
// This file is distributed with Folia under AGPL-3.0.
//
// Only local metadata is indexed: no project is copied and the user's existing desktop wallpaper
// is never replaced. Folia never executes a Web/Application project itself; a `web` project can be
// handed to the user's Wallpaper Engine process through `openWallpaper`, exactly like a scene.

const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');

const WALLPAPER_ENGINE_APP_ID = '431960';
const WALLPAPER_ENGINE_PROTOCOL_SCHEME = 'folia-we';
const MAX_PROJECT_JSON_BYTES = 1024 * 1024;
const MAX_PROJECT_DIRS = 4000;
const MAX_SCENE_PROPERTIES = 256;
const MAX_PROPERTY_OPTIONS = 64;
const SCENE_PACKAGE_EXTENSIONS = new Set(['.pkg', '.pak']);
const PREVIEW_CANDIDATES = ['preview.gif', 'preview.jpg', 'preview.jpeg', 'preview.png', 'preview.webp'];
const PREVIEW_MIME_TYPES = {
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
// Video wallpapers are ordinary media files next to project.json. Chromium can decode MP4/WebM/Ogg
// without Wallpaper Engine, so these are played natively as a built-in background instead of
// starting the engine and capturing its window.
const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
};

// Audio heuristics: which scene properties are volume/mute switches rather than visual effects.
// Ported verbatim in behaviour from the Mineradio source (see the file header).
const AUDIO_PROPERTY_HINT = /(?:\bvolume\b|\bmute(?:d)?\b|\bsilent\b|\baudio\s*(?:volume|level|gain|enable|enabled|toggle)\b|\bmusic\s*(?:volume|level|gain|size|enable|enabled|toggle)\b|\bsound\s*(?:volume|level|gain|enable|enabled|toggle)\b|音量|静音|无声|音乐(?:大小|音量|开关)|声音(?:大小|音量|开关)|音效(?:大小|音量|开关))/i;
const AUDIO_PROPERTY_KEY = /^(?:volume|dbvolume|musicvolume|music_volume|audiovolume|audio_volume|soundvolume|sound_volume|bgmvolume|bgm_volume|muteaudio|audiomute|mutemusic|musicmute|music|audio|sound|bgm)$/i;
const AUDIO_STANDALONE_LABEL = /^(?:(?:background\s*(?:audio|music|sound)|背景(?:音频|音乐|声音))|(?:audio|music|sound|bgm|音频|音乐|声音)(?:[\s,，、/_-]*(?:audio|music|sound|bgm|音频|音乐|声音|\d+))*)$/i;
const AUDIO_VISUAL_HINT = /(?:visuali[sz](?:er|ation)|\bbars?\b|\bring\b|\bpulse\b|\bthreshold\b|\bsensitiv(?:e|ity)\b|\bintensity\b|\bcolou?r\b|\bopacity\b|\btransparen(?:cy|t)\b|\bbounce\b|\bflicker\b|\balbum\b|\binformation\b|\bresponse\b|\breactive\b|\bfrequency\b|\bspectrum\b|\bwave\b|\bnote\b|可视|频谱|跳动|闪烁|响应|颜色|透明|专辑|封面|信息)/i;
const AUDIO_DECIBEL_HINT = /(?:\bdb\b|decibel|分贝)/i;
const AUDIO_OFF_OPTION_HINT = /(?:\bnone\b|\boff\b|\bmute(?:d)?\b|\bsilent\b|\bdisable(?:d)?\b|关闭|静音|无声|不要音乐|无音乐)/i;
const MUTE_PROPERTY_HINT = /(?:\bmute(?:d)?\b|\bsilent\b|静音|无声)/i;
const AUDIO_MUTE_PROPERTY_KEYS = new Set(['muteaudio', 'audiomute', 'mutemusic', 'musicmute']);
const AUDIO_DECIBEL_PROPERTY_KEYS = new Set(['dbvolume']);
const AUDIO_ENABLE_PROPERTY_KEYS = new Set([
  'audioenable', 'audioenabled',
  'musicenable', 'musicenabled',
  'soundenable', 'soundenabled',
  'bgmenable', 'bgmenabled',
]);
const SAFE_PROPERTY_KEY = /^[a-z0-9_.-]{1,128}$/i;
const BLOCKED_PROPERTY_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const workspaceIdForPath = (projectDir) => crypto
  .createHash('sha1')
  .update(String(projectDir).replace(/\\/g, '/').toLowerCase())
  .digest('hex')
  .slice(0, 16);

const normalizeWallpaperProjectType = (value) => {
  const type = String(value || '').trim().toLowerCase();
  return type || 'unknown';
};

// steamapps/libraryfolders.vdf is a Valve KeyValues file. Only the "path" keys of the numbered
// library entries matter here; the parser stays deliberately tolerant of any other nesting.
const parseLibraryFoldersVdf = (text) => {
  const paths = [];
  if (typeof text !== 'string' || text === '') {
    return paths;
  }
  const pattern = /"path"\s+"([^"]+)"/gi;
  let match = pattern.exec(text);
  while (match) {
    const candidate = String(match[1] || '').replace(/\\\\/g, '\\').trim();
    if (candidate && !paths.includes(candidate)) {
      paths.push(candidate);
    }
    match = pattern.exec(text);
  }
  return paths;
};

// A Scene container starts with a 4-byte little-endian length prefix and then the versioned magic
// (real packages read `08 00 00 00 "PKGV0005"`: length 8, then the magic). Offset 0 is still
// accepted because the prefix is not part of the documented format.
const SCENE_PACKAGE_MAGIC = /^PKGV\d{4}$/i;
const SCENE_PACKAGE_MAGIC_OFFSETS = [4, 0];

const findScenePackageMagicOffset = (buffer) => {
  if (!Buffer.isBuffer(buffer)) return -1;
  for (const offset of SCENE_PACKAGE_MAGIC_OFFSETS) {
    if (buffer.length < offset + 8) continue;
    if (SCENE_PACKAGE_MAGIC.test(buffer.subarray(offset, offset + 8).toString('latin1'))) return offset;
  }
  return -1;
};

const isScenePackageHeaderBuffer = (buffer) => findScenePackageMagicOffset(buffer) >= 0;

const sanitizePropertyLabel = (value, fallback) => {
  const label = typeof value === 'string' ? value.trim().slice(0, 256) : '';
  return label || fallback;
};

const normalizeScenePropertyValue = (value, maxLength = 512) => {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return value.slice(0, maxLength);
  }
  return null;
};

// Scans project.general.properties and derives both the display descriptors and the mute patch:
// the mute property set is what gets sent through `-control applyProperties` (see the runtime).
const analyzeSceneProperties = (project) => {
  const muteProperties = Object.create(null);
  muteProperties.volume = 0;
  const descriptors = [];
  const properties = project && project.general && project.general.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    return { properties: descriptors, muteProperties: { ...muteProperties }, audioPropertyCount: 0 };
  }
  let audioPropertyCount = 0;
  for (const [rawKey, rawProperty] of Object.entries(properties)) {
    if (descriptors.length >= MAX_SCENE_PROPERTIES) break;
    const key = String(rawKey || '').trim();
    const property = rawProperty && typeof rawProperty === 'object' && !Array.isArray(rawProperty)
      ? rawProperty
      : null;
    if (!property || !SAFE_PROPERTY_KEY.test(key) || BLOCKED_PROPERTY_KEYS.has(key.toLowerCase())) continue;
    const type = String(property.type || '').trim().toLowerCase();
    const label = sanitizePropertyLabel(property.text, key);
    const hint = key + ' ' + label;
    const normalizedKey = key.replace(/[_.-]/g, '').toLowerCase();
    const exactAudioKey = AUDIO_PROPERTY_KEY.test(key);
    const explicitAudioControl = AUDIO_PROPERTY_HINT.test(hint)
      || AUDIO_MUTE_PROPERTY_KEYS.has(normalizedKey)
      || AUDIO_DECIBEL_PROPERTY_KEYS.has(normalizedKey)
      || AUDIO_ENABLE_PROPERTY_KEYS.has(normalizedKey);
    const visualOnly = AUDIO_VISUAL_HINT.test(hint) && !explicitAudioControl;
    const audioProperty = !visualOnly && (
      exactAudioKey
      || explicitAudioControl
      || AUDIO_STANDALONE_LABEL.test(label)
    );
    const options = Array.isArray(property.options)
      ? property.options.slice(0, MAX_PROPERTY_OPTIONS).map((option, index) => {
        const source = option && typeof option === 'object' && !Array.isArray(option) ? option : {};
        return {
          label: sanitizePropertyLabel(source.label, '选项 ' + (index + 1)),
          value: normalizeScenePropertyValue(source.value, 256),
        };
      }).filter((option) => option.value !== null)
      : [];
    const descriptor = {
      key,
      label,
      type: type.replace(/[^a-z0-9_-]/g, '').slice(0, 32) || 'unknown',
      value: normalizeScenePropertyValue(property.value),
      audio: audioProperty,
      autoMuted: false,
    };
    const minimum = Number(property.min);
    const maximum = Number(property.max);
    if (Number.isFinite(minimum)) descriptor.min = minimum;
    if (Number.isFinite(maximum)) descriptor.max = maximum;
    if (options.length) descriptor.options = options;
    if (audioProperty) {
      audioPropertyCount += 1;
      let muteValue;
      if (type === 'bool' || typeof property.value === 'boolean') {
        muteValue = AUDIO_MUTE_PROPERTY_KEYS.has(normalizedKey) || MUTE_PROPERTY_HINT.test(hint);
      } else if (type === 'slider' || typeof property.value === 'number') {
        if (AUDIO_DECIBEL_PROPERTY_KEYS.has(normalizedKey)
          || AUDIO_DECIBEL_HINT.test(hint)
          || (Number.isFinite(minimum) && minimum < 0 && Number.isFinite(maximum) && maximum <= 0)) {
          muteValue = Number.isFinite(minimum) ? minimum : -60;
        } else if ((!Number.isFinite(minimum) || minimum <= 0) && (!Number.isFinite(maximum) || maximum >= 0)) {
          muteValue = 0;
        } else if (Number.isFinite(minimum)) {
          muteValue = minimum;
        }
      } else if (type === 'combo' && options.length) {
        const offOption = options.find((option) => AUDIO_OFF_OPTION_HINT.test(option.label))
          || (exactAudioKey ? options.find((option) => String(option.value) === '0') : null);
        if (offOption) muteValue = offOption.value;
      }
      if (muteValue !== undefined && muteValue !== null) {
        muteProperties[key] = muteValue;
        descriptor.autoMuted = true;
      }
    }
    descriptors.push(descriptor);
  }
  return { properties: descriptors, muteProperties: { ...muteProperties }, audioPropertyCount };
};

const deriveSceneMuteProperties = (project) => analyzeSceneProperties(project).muteProperties;

// Registry query stays a plain text parse: `reg query` output is "    Name    REG_SZ    value".
const parseRegQueryValue = (stdout, valueName) => {
  const lines = String(stdout || '').split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*(\S.*?)\s{2,}(REG_SZ|REG_EXPAND_SZ)\s{2,}(.*)$/i.exec(line);
    if (match && match[1].toLowerCase() === String(valueName).toLowerCase()) {
      return match[3].trim();
    }
  }
  return '';
};

// Two registry values (and the vdf) can name the same directory with different spelling — HKCU
// reports `e:/steam` while HKLM reports `E:\steam` — so root identity is compared on a normalised
// key, otherwise every container gets scanned once per spelling.
const rootIdentity = (value) => String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

const dedupeRoots = (values) => {
  const seen = new Set();
  const roots = [];
  for (const value of values) {
    const identity = rootIdentity(value);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    roots.push(value);
  }
  return roots;
};

// Steam install roots from the registry: HKCU holds the per-user install, the two HKLM keys
// cover a machine-wide install (32-bit Steam registers under WOW6432Node).
const readSteamRoots = async ({ execFile }) => {
  const candidates = [
    { hive: 'HKCU\\Software\\Valve\\Steam', value: 'SteamPath' },
    { hive: 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', value: 'InstallPath' },
    { hive: 'HKLM\\SOFTWARE\\Valve\\Steam', value: 'InstallPath' },
  ];
  const found = [];
  for (const candidate of candidates) {
    try {
      const stdout = await new Promise((resolve, reject) => {
        execFile('reg', ['query', candidate.hive, '/v', candidate.value], {
          timeout: 5000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        }, (error, out) => (error ? reject(error) : resolve(out)));
      });
      const value = parseRegQueryValue(stdout, candidate.value);
      if (value) found.push(value);
    } catch {
      // Missing hive/value is the normal case on a machine without that install flavour.
    }
  }
  return dedupeRoots(found);
};

// Every Steam library folder, plus the Steam root itself (a library may live on another drive).
const readLibraryRoots = async ({ fsp, path, steamRoot }) => {
  const found = [steamRoot];
  const vdfPath = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  try {
    const text = await fsp.readFile(vdfPath, 'utf8');
    for (const entry of parseLibraryFoldersVdf(text)) {
      if (entry) found.push(entry);
    }
  } catch {
    // No libraryfolders.vdf: the root itself still holds the default library.
  }
  return dedupeRoots(found);
};

// Registry + vdf in one step; the runtime reuses this to locate wallpaper64.exe.
const resolveSteamLibraryRoots = async ({ fsp, path, execFile }) => {
  const steamRoots = await readSteamRoots({ execFile });
  const found = [];
  for (const steamRoot of steamRoots) {
    for (const root of await readLibraryRoots({ fsp, path, steamRoot })) {
      found.push(root);
    }
  }
  return { steamRoots, libraryRoots: dedupeRoots(found) };
};

function createWallpaperEngineLibrary(options = {}) {
  const {
    fs,
    path,
    execFile,
    logWarn = () => {},
    cacheTtlMs = 30000,
  } = options;
  const fsp = fs.promises;

  // id → item index; rebuilt on every scan and read by get-sources / preview protocol lookups.
  let items = new Map();
  let scannedAt = 0;
  let scanPromise = null;
  let lastSteamRoots = [];

  const statDirectory = async (target) => {
    try {
      const stats = await fsp.stat(target);
      return stats.isDirectory() ? stats : null;
    } catch {
      return null;
    }
  };

  const readJsonFileCapped = async (filePath, maxBytes) => {
    let handle = null;
    try {
      handle = await fsp.open(filePath, 'r');
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size <= 0 || stats.size > maxBytes) return null;
      const buffer = Buffer.alloc(Number(stats.size));
      await handle.read(buffer, 0, buffer.length, 0);
      return JSON.parse(buffer.toString('utf8').replace(/^﻿/, ''));
    } catch {
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  };

  const readScenePackageHeader = async (filePath) => {
    let handle = null;
    try {
      handle = await fsp.open(filePath, 'r');
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      if (bytesRead < 8) return null;
      const offset = findScenePackageMagicOffset(buffer);
      return offset < 0 ? null : buffer.subarray(offset, offset + 8).toString('latin1');
    } catch {
      return null;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  };

  const findScenePackage = async (projectDir, project) => {
    const declared = typeof project.file === 'string' ? project.file.trim() : '';
    const candidates = [];
    if (declared && SCENE_PACKAGE_EXTENSIONS.has(path.extname(declared).toLowerCase())) {
      candidates.push(path.join(projectDir, declared));
    }
    try {
      const entries = await fsp.readdir(projectDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!SCENE_PACKAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const candidate = path.join(projectDir, entry.name);
        if (!candidates.includes(candidate)) candidates.push(candidate);
      }
    } catch {
      return null;
    }
    for (const candidate of candidates) {
      const header = await readScenePackageHeader(candidate);
      if (header) return { filePath: candidate, header };
    }
    return null;
  };

  // Resolves project.file only when it stays inside the project directory and has a media type we
  // know how to serve. The renderer never sees this path; the protocol handler resolves an item id
  // back to it, so a crafted URL cannot read arbitrary files.
  const resolveProjectFile = async (projectDir, declared, mimeTypes) => {
    const relative = typeof declared === 'string' ? declared.trim() : '';
    if (!relative) return null;
    const root = path.resolve(projectDir);
    const resolved = path.resolve(root, relative);
    const rel = path.relative(root, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const extension = path.extname(resolved).toLowerCase();
    const mimeType = mimeTypes[extension];
    if (!mimeType) return null;
    try {
      // Resolve symlinks/junctions as well: a project can contain a link that points outside its
      // directory, and the renderer must only ever stream files that really live inside it.
      const [realRoot, realFile] = await Promise.all([fsp.realpath(root), fsp.realpath(resolved)]);
      const realRelative = path.relative(realRoot, realFile);
      if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative)) return null;
      const stats = await fsp.stat(realFile);
      if (!stats.isFile() || stats.size <= 0) return null;
      return { filePath: realFile, mimeType, size: stats.size };
    } catch {
      return null;
    }
  };

  const findPreviewFile = async (projectDir, project) => {
    const declared = typeof project.preview === 'string' ? project.preview.trim() : '';
    const candidates = [];
    if (declared) candidates.push(path.join(projectDir, declared));
    for (const name of PREVIEW_CANDIDATES) candidates.push(path.join(projectDir, name));
    for (const candidate of candidates) {
      const extension = path.extname(candidate).toLowerCase();
      const mimeType = PREVIEW_MIME_TYPES[extension];
      if (!mimeType) continue;
      try {
        const stats = await fsp.stat(candidate);
        if (stats.isFile() && stats.size > 0) {
          return { filePath: candidate, mimeType, size: stats.size };
        }
      } catch {
        // Try the next candidate.
      }
    }
    return null;
  };

  const indexProject = async (projectDir, sourceKind) => {
    const projectFile = path.join(projectDir, 'project.json');
    const project = await readJsonFileCapped(projectFile, MAX_PROJECT_JSON_BYTES);
    if (!project || typeof project !== 'object' || Array.isArray(project)) return null;
    const type = normalizeWallpaperProjectType(project.type);
    const scenePackage = type === 'scene' ? await findScenePackage(projectDir, project) : null;
    const video = type === 'video' ? await resolveProjectFile(projectDir, project.file, VIDEO_MIME_TYPES) : null;
    const preview = await findPreviewFile(projectDir, project);
    const analysis = analyzeSceneProperties(project);
    const title = typeof project.title === 'string' && project.title.trim()
      ? project.title.trim().slice(0, 200)
      : path.basename(projectDir);
    const workshopId = /^\d+$/.test(path.basename(path.dirname(projectDir)))
      ? path.basename(path.dirname(projectDir))
      : '';
    return {
      id: workspaceIdForPath(projectDir),
      title,
      type,
      sourceKind,
      projectDir,
      projectFile,
      workshopId,
      // Scene projects need a valid PKGV package; web projects are opened by the engine from
      // project.json directly. Both use the hardened engine-capture path. Video projects never do.
      enginePlayable: (type === 'scene' && Boolean(scenePackage)) || type === 'web',
      // Video projects are played by Chromium directly; this never starts Wallpaper Engine.
      builtinPlayable: type === 'video' && Boolean(video),
      builtinKind: type === 'video' && video ? 'video' : '',
      videoFile: video ? video.filePath : '',
      videoMimeType: video ? video.mimeType : '',
      videoSize: video ? video.size : 0,
      scenePackageFile: scenePackage ? scenePackage.filePath : '',
      scenePackageHeader: scenePackage ? scenePackage.header : '',
      previewFile: preview ? preview.filePath : '',
      previewMimeType: preview ? preview.mimeType : '',
      muteProperties: analysis.muteProperties,
      audioPropertyCount: analysis.audioPropertyCount,
    };
  };

  const collectProjectDirs = async (containerDir, sourceKind) => {
    const stats = await statDirectory(containerDir);
    if (!stats) return [];
    const found = [];
    let entries = [];
    try {
      entries = await fsp.readdir(containerDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (found.length >= MAX_PROJECT_DIRS) break;
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(containerDir, entry.name);
      try {
        const projectStats = await fsp.stat(path.join(projectDir, 'project.json'));
        if (projectStats.isFile()) found.push({ projectDir, sourceKind });
      } catch {
        // Not a WE project directory.
      }
    }
    return found;
  };

  const scan = async () => {
    if (scanPromise) return scanPromise;
    const operation = (async () => {
      const { steamRoots, libraryRoots } = await resolveSteamLibraryRoots({ fsp, path, execFile });
      lastSteamRoots = steamRoots;
      const containers = [];
      for (const root of libraryRoots) {
        containers.push({
          dir: path.join(root, 'steamapps', 'workshop', 'content', WALLPAPER_ENGINE_APP_ID),
          sourceKind: 'workshop',
        });
        containers.push({
          dir: path.join(root, 'steamapps', 'common', 'wallpaper_engine', 'projects', 'myprojects'),
          sourceKind: 'myprojects',
        });
      }
      const candidates = [];
      for (const container of containers) {
        for (const candidate of await collectProjectDirs(container.dir, container.sourceKind)) {
          candidates.push(candidate);
        }
      }
      const nextItems = new Map();
      for (const candidate of candidates) {
        const item = await indexProject(candidate.projectDir, candidate.sourceKind);
        if (item) nextItems.set(item.id, item);
      }
      items = nextItems;
      scannedAt = Date.now();
      const list = [...items.values()].sort((left, right) => left.title.localeCompare(right.title, 'zh-Hans-CN'));
      return {
        ok: true,
        steamRoots,
        libraryRoots,
        total: list.length,
        items: list,
      };
    })();
    scanPromise = operation;
    try {
      return await operation;
    } finally {
      scanPromise = null;
    }
  };

  const ensureFresh = async (force = false) => {
    if (force || items.size === 0 || Date.now() - scannedAt > cacheTtlMs) {
      return scan();
    }
    return { ok: true, steamRoots: lastSteamRoots, total: items.size, items: [...items.values()] };
  };

  const getItem = (id) => items.get(String(id || '')) || null;

  // Video is played by the renderer's <video> element, which issues Range requests for seeking and
  // looping. The file is streamed from disk (never read into a Buffer) and only for an item id in
  // the scan index; the renderer cannot name a path.
  const serveVideo = async (request, item) => {
    if (!item.videoFile) return new Response('Not found', { status: 404 });
    let stats;
    try {
      stats = await fsp.stat(item.videoFile);
    } catch {
      return new Response('Not found', { status: 404 });
    }
    if (!stats.isFile() || stats.size <= 0) return new Response('Not found', { status: 404 });
    const size = Number(stats.size);
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': item.videoMimeType || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    };
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(String(range).trim());
      if (!match) {
        return new Response('Range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        });
      }
      let start;
      let end;
      if (!match[1] && match[2]) {
        // Suffix range: "bytes=-1024" means the last 1024 bytes.
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          return new Response('Range not satisfiable', {
            status: 416,
            headers: { 'Content-Range': `bytes */${size}` },
          });
        }
        start = Math.max(0, size - suffix);
        end = size - 1;
      } else {
        start = match[1] ? Number(match[1]) : 0;
        end = match[2] ? Number(match[2]) : size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) {
        return new Response('Range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        });
      }
      end = Math.min(end, size - 1);
      const length = end - start + 1;
      const rangeHeaders = {
        ...headers,
        'Content-Length': String(length),
        'Content-Range': `bytes ${start}-${end}/${size}`,
      };
      if (request.method === 'HEAD') return new Response(null, { status: 206, headers: rangeHeaders });
      const stream = fs.createReadStream(item.videoFile, { start, end });
      return new Response(Readable.toWeb(stream), { status: 206, headers: rangeHeaders });
    }
    const fullHeaders = { ...headers, 'Content-Length': String(size) };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: fullHeaders });
    const stream = fs.createReadStream(item.videoFile);
    return new Response(Readable.toWeb(stream), { status: 200, headers: fullHeaders });
  };

  // folia-we://preview/<itemId> serves the preview thumbnail of an already-indexed project;
  // folia-we://media/<itemId> streams a video project. The renderer never supplies a path: the item
  // id is resolved against the scan index, so only files inside a discovered Wallpaper Engine
  // project directory can ever be read.
  const registerProtocolHandler = (protocol, net) => {
    protocol.handle(WALLPAPER_ENGINE_PROTOCOL_SCHEME, async (request) => {
      let hostname = '';
      let itemId = '';
      try {
        const url = new URL(request.url);
        hostname = url.hostname;
        itemId = decodeURIComponent(url.pathname.replace(/^\//, ''));
        if (hostname !== 'preview' && hostname !== 'media') throw new Error('Invalid wallpaper engine host');
      } catch {
        return new Response('Bad request', { status: 400 });
      }
      const item = getItem(itemId);
      if (!item) return new Response('Not found', { status: 404 });
      if (hostname === 'media') return serveVideo(request, item);
      if (!item.previewFile) return new Response('Not found', { status: 404 });
      const fileResponse = await net.fetch(pathToFileURL(item.previewFile).toString());
      if (!fileResponse.ok || !fileResponse.body) return new Response('Not found', { status: 404 });
      return new Response(fileResponse.body, {
        status: 200,
        headers: {
          'Cache-Control': 'public, max-age=86400',
          'Content-Type': item.previewMimeType,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });
  };

  return {
    scan,
    ensureFresh,
    getItem,
    listItems: () => [...items.values()],
    getSteamRoots: () => lastSteamRoots,
    registerProtocolHandler,
  };
}

module.exports = {
  WALLPAPER_ENGINE_APP_ID,
  WALLPAPER_ENGINE_PROTOCOL_SCHEME,
  MAX_PROJECT_JSON_BYTES,
  analyzeSceneProperties,
  createWallpaperEngineLibrary,
  deriveSceneMuteProperties,
  findScenePackageMagicOffset,
  isScenePackageHeaderBuffer,
  normalizeWallpaperProjectType,
  parseLibraryFoldersVdf,
  parseRegQueryValue,
  readLibraryRoots,
  readSteamRoots,
  resolveSteamLibraryRoots,
  workspaceIdForPath,
};
