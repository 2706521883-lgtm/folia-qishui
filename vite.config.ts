import path from 'path';
import { fileURLToPath } from 'url';
import { type ConfigEnv, type HtmlTagDescriptor, type UserConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { commandPinyinPlugin } from './dev/pinyin/commandPinyinPlugin.mjs';
import { traditionalLocalePlugin } from './dev/i18n/traditionalLocalePlugin.mjs';
import { icuFoliaDataPlugin } from './dev/icuFolia/icuFoliaDataPlugin.mjs';
import { normalizeBuildCommit, resolveBuildRepo } from './dev/build/buildIdentity.mjs';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LYRIC_PROXY_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS,PATCH,DELETE,POST,PUT',
  'Access-Control-Allow-Headers': [
    'X-CSRF-Token',
    'X-Requested-With',
    'Accept',
    'Accept-Version',
    'Content-Length',
    'Content-MD5',
    'Content-Type',
    'Date',
    'X-Api-Version',
    'KG-Rec',
    'KG-RC',
    'KG-CLIENTTIMEMS',
    'mid',
    'x-router',
  ].join(', '),
};

const LYRIC_PROXY_IGNORED_FORWARD_HEADERS = ['host', 'connection', 'content-length', 'origin', 'referer'];

function isAllowedLyricProxyHost(hostname: string): boolean {
  return hostname === 'qq.com' || hostname.endsWith('.qq.com') ||
    hostname === 'y.gtimg.cn' ||
    hostname === 'kugou.com' || hostname.endsWith('.kugou.com') ||
    hostname === 'kgimg.com' || hostname.endsWith('.kgimg.com');
}

function setLyricProxyCorsHeaders(res: import('http').ServerResponse): void {
  Object.entries(LYRIC_PROXY_CORS_HEADERS).forEach(([key, value]) => {
    res.setHeader(key, value);
  });
}

function sendLyricProxyJson(res: import('http').ServerResponse, statusCode: number, body: unknown): void {
  setLyricProxyCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function readDevRequestBody(req: import('http').IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

function devLyricProxyPlugin() {
  return {
    name: 'folia-dev-lyric-proxy',
    apply: 'serve' as const,
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = new URL(req.url ?? '/', 'http://localhost');
        if (requestUrl.pathname !== '/api/lyric-proxy') {
          next();
          return;
        }

        if (req.method === 'OPTIONS') {
          setLyricProxyCorsHeaders(res);
          res.statusCode = 200;
          res.end();
          return;
        }

        const targetUrlStr = requestUrl.searchParams.get('url');
        if (!targetUrlStr) {
          sendLyricProxyJson(res, 400, { error: 'Missing url parameter' });
          return;
        }

        try {
          const targetUrl = new URL(targetUrlStr);
          if (!isAllowedLyricProxyHost(targetUrl.hostname)) {
            sendLyricProxyJson(res, 403, { error: 'Forbidden: Domain not allowed' });
            return;
          }

          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (!LYRIC_PROXY_IGNORED_FORWARD_HEADERS.includes(key.toLowerCase()) && value) {
              headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            }
          }

          const hasBody = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '');
          const response = await fetch(targetUrl.toString(), {
            method: req.method,
            headers,
            body: hasBody ? await readDevRequestBody(req) : undefined,
          });

          setLyricProxyCorsHeaders(res);

          res.statusCode = response.status;
          res.statusMessage = response.statusText;
          const contentType = response.headers.get('content-type');
          if (contentType) {
            res.setHeader('Content-Type', contentType);
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          res.end(buffer);
        } catch (error) {
          console.error('Vite lyric proxy request failed:', error);
          sendLyricProxyJson(res, 500, { error: 'Proxy request failed', details: String(error) });
        }
      });
    },
  };
}

// Dev-only helpers injected into every dev HTML page (apply: 'serve' keeps all of this out of
// production builds):
// 1) eruda 手机调试台：URL 带 ?debug=1 时从 /__eruda.js 加载并 eruda.init()。
// 2) SW 启动保护：dev 下给 navigator.serviceWorker.register() 包一层超时。背景（2026-10-15 实测）：
//    dev SW 曾与 Folia 封面 SW 抢 scope '/' 把浏览器 SW 队列堵死，而应用的启动链 `await register()`
//    没有超时 → React 永不挂载、整页黑屏。这层保护 5s 不返回就放弃注册继续启动（只影响开发模式，
//    代价是没有封面 SW；浏览器重启后 SW 恢复正常时这层不会触发）。
// 3) 隐藏上游的 DEV suite 切换浮层（src/library/app/DevLibraryRendererSwitch.tsx，资料库左下角的
//    「DEV · 集合视图 网格 / Bravais 墙面」）。它给上游开发验收用，生产构建根本不打包它，但开发时
//    一直挂在墙上挡位置。显式启用额外 suite 时保留（VITE_LIBRARY_TUI=true，测试配置会带这个变量起
//    服务）：那时浮层是切到 TUI 的入口，e2e 也依赖它点击。切换 suite 的正规入口在设置「资料库界面」。
const DEV_SW_REGISTER_GUARD_MS = 5000;
const HIDE_DEV_SUITE_SWITCH = process.env.VITE_LIBRARY_TUI !== 'true';

function devErudaPlugin() {
  let erudaSource: string | null = null;
  return {
    name: 'folia-dev-eruda',
    apply: 'serve' as const,
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/__eruda.js', (_req, res) => {
        let source = erudaSource;
        if (source === null) {
          try {
            source = fs.readFileSync(path.resolve(__dirname, 'node_modules/eruda/eruda.js'), 'utf-8');
          } catch {
            res.statusCode = 404;
            res.end('// eruda is not installed: npm i -D eruda');
            return;
          }
          erudaSource = source;
        }
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.end(source);
      });
    },
    transformIndexHtml(): HtmlTagDescriptor[] {
      const hideDevSuiteSwitchTags: HtmlTagDescriptor[] = HIDE_DEV_SUITE_SWITCH
        ? [{
            tag: 'style',
            injectTo: 'head',
            children: '[data-testid="dev-library-renderer-switch"] { display: none !important; }',
          }]
        : [];
      return [
        {
          tag: 'script',
          injectTo: 'head-prepend',
          children: `(function(){
  try {
    var sw = navigator.serviceWorker;
    if (!sw || !sw.register) return;
    var orig = sw.register.bind(sw);
    var T = ${DEV_SW_REGISTER_GUARD_MS};
    sw.register = function () {
      var real = orig.apply(null, arguments);
      var guard = new Promise(function (_, reject) {
        setTimeout(function () {
          reject(new Error('folia-dev: serviceWorker.register() 超过 ' + T + 'ms 没有结果（浏览器 SW 队列疑似卡死），跳过并继续启动（仅开发模式的保护）。'));
        }, T);
      });
      return Promise.race([real, guard]);
    };
  } catch (e) {}
})();`,
        },
        ...hideDevSuiteSwitchTags,
        {
          tag: 'script',
          injectTo: 'body',
          children:
            "(function(){if(!new URLSearchParams(location.search).has('debug'))return;" +
            "var s=document.createElement('script');s.src='/__eruda.js';" +
            "s.onload=function(){try{window.eruda&&window.eruda.init();}catch(e){}};" +
            '(document.head||document.documentElement).appendChild(s);})();',
        },
      ];
    },
  };
}

export default async function viteConfig(_config: ConfigEnv): Promise<UserConfig> {
  let commitHash = '';
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    commitHash = process.env.VERCEL_GIT_COMMIT_SHA.substring(0, 7);
  } else {
    try {
      commitHash = execSync('git rev-parse --short HEAD').toString().trim();
    } catch (e) {
      console.warn('Could not get commit hash:', e);
      commitHash = 'unknown, probably dev version';
    }
  }

  let gitBranch = '';
  if (process.env.VERCEL_GIT_COMMIT_REF) {
    gitBranch = process.env.VERCEL_GIT_COMMIT_REF;
  } else {
    try {
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    } catch (e) {
      console.warn('Could not get git branch:', e);
      gitBranch = 'unknown';
    }
  }

  let commitSuffix = '';
  const canResolveCommitName = /^[0-9a-f]{7,40}$/i.test(commitHash) && !/^0+$/.test(commitHash);
  if (canResolveCommitName) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`https://namoe.izuna.top/api/namoe?hash=${commitHash}`, {
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json() as { name?: string };
        if (data?.name) {
          commitSuffix = `/${data.name}`;
        }
      }
    } catch (e) {
      // Ignore errors during fetch to prevent build failure
    }
  }
  if (process.env.REQUIRE_COMMIT_NAME === 'true' && canResolveCommitName && !commitSuffix) {
    throw new Error(`Could not resolve the commit name for ${commitHash}`);
  }

  // 请求 AMLL 官方 API 时 UA 里的构建身份，见 dev/build/buildIdentity.mjs
  const buildRepo = resolveBuildRepo(process.env, () => execSync('git remote get-url origin', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  const buildCommit = normalizeBuildCommit(commitHash);

  const appVersionLabel = process.env.APP_VERSION_LABEL?.trim() || 'Folia';
  const appReleaseChannel = process.env.APP_RELEASE_CHANNEL?.trim().toLowerCase() || 'realeco';
  const dockerStackVersion = process.env.DOCKER_STACK_VERSION?.trim() || '';

  // 移动端壳（Capacitor）构建：npm run build:mobile 置位。只影响两处产出——相对 base
  // （壳里页面从 https://localhost / capacitor://localhost 根加载，相对路径最稳）与关掉
  // PWA 插件（壳内没有 service worker 基建，插件还会往 HTML 注入注册脚本）。
  const isCapacitorBuild = process.env.FOLIA_BUILD_TARGET === 'capacitor';

  return {
    base: process.env.ELECTRON === 'true' || isCapacitorBuild ? './' : '/',
    worker: {
      format: 'es'
    },
    optimizeDeps: {
      // Only metadataParser.worker.ts imports music-metadata, and the startup dep scan does not
      // follow worker entries. Left out, the first local import discovers it at runtime, Vite
      // re-optimizes, and every open page is force-reloaded ("optimized dependencies changed").
      include: ['music-metadata'],
    },
    build: {
      rollupOptions: {
        input: {
          main: 'index.html',
          stageClient: 'stage-client.html',
          modExport: 'mod-export.html',
        },
        output: {
          // three.js is a large dependency used only by the diorama 3D visualizer. Split it into its
          // own chunk so it doesn't bloat the main bundle past the PWA precache size limit (each file
          // must stay under workbox.maximumFileSizeToCacheInBytes to be cached for offline use).
          manualChunks(id) {
            return id.includes('/node_modules/three/') ? 'three' : undefined;
          },
          // folium.ui.icon loads each lucide icon as its own chunk (~2000 of them). They live in one
          // directory so the PWA precache can leave them out: only mods ask for them, and mods run in
          // the desktop app, which does not go through the service worker.
          chunkFileNames(chunk) {
            return chunk.moduleIds.some(id => id.includes('/node_modules/lucide-react/dist/esm/icons/'))
              && chunk.moduleIds.length === 1
              ? 'assets/folium-icons/[name]-[hash].js'
              : 'assets/[name]-[hash].js';
          },
        },
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      watch: {
        // Build output and model weights are not sources, and watching them breaks packaging: the
        // watcher opens a handle on every directory it finds, and electron-builder packages by
        // extracting Electron into release/win-unpacked.tmp and renaming it to release/win-unpacked.
        // On Windows that rename fails with EPERM while anything holds the directory - so a dev
        // server left running in another terminal kills every `npm run build:electron`.
        ignored: ['**/release/**', '**/models/**'],
      },
    },
    plugins: [
      devLyricProxyPlugin(),
      devErudaPlugin(),
      commandPinyinPlugin(),
      traditionalLocalePlugin(),
      icuFoliaDataPlugin(),
      react(),
      // 移动端壳构建不装 PWA 插件（见上方 isCapacitorBuild 注释）。
      ...(isCapacitorBuild ? [] : [VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['icon.svg'],
        devOptions: {
          // 开发模式下不注册 PWA 的 dev-service-worker（2026-10-15 实测后关闭）。原因：dev SW 与
          // Folia 自己的封面 SW（public/folia-cover-sw.js，应用启动时按 scope '/' 注册）会互相顶替，
          // 每个页面加载都是一次控制器替换；多 frame 预览台同时刷新时把浏览器的 SW 注册队列堵死，
          // 而应用启动链里的 `await navigator.serviceWorker.register(...)` 没有超时，React 就永远不
          // 挂载（黑屏）。关掉后 dev 下只剩封面 SW 一个稳定注册；生产构建不走这里，行为不变。
          enabled: false
        },
        workbox: {
          maximumFileSizeToCacheInBytes: 5000000,
          // Docker serves this file dynamically; it must never be pinned in the PWA precache.
          globIgnores: ['**/runtime-config.js', '**/assets/folium-icons/**'],
          // API navigations must reach the deployment platform instead of the SPA shell.
          navigateFallbackDenylist: [/^\/api(?:\/|$)/]
        },
        manifest: {
          name: 'Folia Music',
          short_name: 'Folia',
          description: 'A beautiful AI-themed music player',
          theme_color: '#09090b',
          background_color: '#09090b',
          display: 'standalone',
          icons: [
            {
              src: 'icon.svg',
              sizes: '512x512',
              type: 'image/svg+xml',
              purpose: 'any maskable'
            }
          ]
        }
      })])
    ],
    define: {
      '__COMMIT_HASH__': JSON.stringify(commitHash + commitSuffix),
      '__GIT_BRANCH__': JSON.stringify(gitBranch),
      '__BUILD_REPO__': JSON.stringify(buildRepo),
      '__BUILD_COMMIT__': JSON.stringify(buildCommit),
      '__APP_VERSION__': JSON.stringify(JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')).version),
      '__APP_VERSION_LABEL__': JSON.stringify(appVersionLabel),
      '__APP_RELEASE_CHANNEL__': JSON.stringify(appReleaseChannel),
      '__DOCKER_STACK_VERSION__': JSON.stringify(dockerStackVersion)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      }
    }
  };
}
