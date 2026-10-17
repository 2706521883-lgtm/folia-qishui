#!/usr/bin/env node
/**
 * 组装 App 内置 Node 工程（酷狗 / QQ / 汽水）。
 *
 * 用法：
 *   node dev/mobile/prepare-node-project.mjs --install --dist
 *
 *   --out <dir>   输出目录（默认 build/nodejs-project）
 *   --install     在输出目录执行 npm install --omit=dev（CI 与本地打包都需要）
 *   --dist        组装完成后同步到 dist/nodejs-project，供 npx cap sync 带进 App
 *
 * 只复制运行所需的文件；qishui-api.js 由 electron/qishui 复制过来，保证桌面/手机同一份协议实现。
 * 不读取、不复制任何用户 Cookie 或凭据文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);

function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

const outDir = path.resolve(root, argValue('--out', path.join('build', 'nodejs-project')));
const shouldInstall = args.includes('--install') || process.env.FOLIA_NODE_INSTALL === '1';
const copyToDist = args.includes('--dist');

const SKIP_NAMES = new Set(['node_modules', '.git', '.github', 'test', 'tests', '__tests__', '.DS_Store']);

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(source);
      const stat = fs.statSync(real);
      if (stat.isDirectory()) copyTree(real, target);
      else fs.copyFileSync(real, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}

function rimraf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function replaceSymlinkWithCopy(target) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (_) { return; }
  if (!stat.isSymbolicLink()) return;
  const real = fs.realpathSync(target);
  fs.unlinkSync(target);
  if (fs.statSync(real).isDirectory()) copyTree(real, target);
  else fs.copyFileSync(real, target);
}

function runNpmInstall(cwd) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('[prepare-node] npm install (omit dev) in ' + cwd);
  const result = spawnSync(npm, ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, npm_config_loglevel: process.env.npm_config_loglevel || 'warn' },
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('npm install failed with exit code ' + result.status);
  // npm 对 file: 依赖默认建软链；IPA 里软链既可能丢失也可能过不了校验，一律换成真拷贝。
  replaceSymlinkWithCopy(path.join(cwd, 'node_modules', 'kugoumusicapi'));
}

function buildIdFor(dir) {
  const hash = crypto.createHash('sha256');
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules' || entry.name === 'build.json') continue;
      const full = path.join(current, entry.name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) hash.update(path.relative(dir, full)).update('\0').update(fs.readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex').slice(0, 16);
}

console.log('[prepare-node] source ' + path.join(root, 'mobile', 'nodejs-project'));
rimraf(outDir);
fs.mkdirSync(outDir, { recursive: true });

// 1) App 内服务端源码（main.js / qishui-inapp.cjs / package.json）
copyTree(path.join(root, 'mobile', 'nodejs-project'), outDir);

// 2) 酷狗 vendored 服务端
copyTree(path.join(root, 'vendor', 'KuGouMusicApi'), path.join(outDir, 'vendor', 'KuGouMusicApi'));

// 3) 桌面版同一份汽水协议实现
fs.mkdirSync(path.join(outDir, 'qishui'), { recursive: true });
fs.copyFileSync(
  path.join(root, 'electron', 'qishui', 'qishui-api.js'),
  path.join(outDir, 'qishui', 'qishui-api.js')
);

// 4) 组装 + 安装依赖
if (shouldInstall) runNpmInstall(outDir);

const buildId = buildIdFor(outDir);
fs.writeFileSync(path.join(outDir, 'build.json'), JSON.stringify({
  buildId,
  builtAt: new Date().toISOString(),
  source: 'folia-qishui/mobile/nodejs-project',
}, null, 2) + '\n');
console.log('[prepare-node] assembled ' + outDir + ' buildId=' + buildId);

if (copyToDist) {
  const distDir = path.join(root, 'dist', 'nodejs-project');
  rimraf(distDir);
  copyTree(outDir, distDir);
  console.log('[prepare-node] copied to ' + distDir);
}
