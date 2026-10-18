const path = require('node:path');
const { keepServerErrorsLogged, waitUntilListening } = require('./backendLifecycle.cjs');
const { registerQqPersonalFmRoute } = require('./qqRecommendRoute.cjs');

// electron/qqApiStartup.cjs
//
// Starts @yakult-green-tea/qq-music-api inside the Electron main process. The package is a regular
// production dependency, so npm nests its own ws@7 under it and the app's ws@8 is left alone.

const QQ_API_MODULE = '@yakult-green-tea/qq-music-api';

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return typeof error === 'string' && error.trim() ? error : 'Unknown error';
}

// A missing package is a packaging problem the user can act on; anything else (a port that is
// already taken, a throw from inside the package) is a runtime failure. Callers map the two to
// different statuses, so the distinction must survive the throw.
function isModuleNotFound(error) {
  return Boolean(error) && error.code === 'MODULE_NOT_FOUND';
}

// The package calls app.listen() while it is being required, so require() returns before the socket
// is bound. Resolving only on 'listening' (waitUntilListening) keeps the caller from reporting "running"
// against a port that may still fail to bind; a bind failure arrives as a rejection rather than an
// unhandled event on the server.

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }

    server.close(() => resolve());
  });
}

// qq-music-api 3.1.4 does not ship a personal-FM route. Register ours on the package's own Koa
// router right after the package is required (the server is listening but no request has been
// dispatched yet, so adding a route here is safe). Internal paths are resolved from the package
// entry rather than imported through its `exports`, which deliberately exposes only the root.
const registerQqRoutesFromPackage = (moduleId) => {
  const packageRoot = path.dirname(require.resolve(moduleId));
  const routerModule = require(path.join(packageRoot, 'routes', 'router.js'));
  const servicesModule = require(path.join(packageRoot, 'services', 'index.js'));
  const router = routerModule && routerModule.default ? routerModule.default : routerModule;
  const services = servicesModule && servicesModule.default ? servicesModule.default : servicesModule;
  if (!registerQqPersonalFmRoute({ router, services })) {
    throw new Error(`QQ API package ${moduleId} did not expose a router`);
  }
};

const defaultLoadModule = (moduleId) => {
  const loaded = require(moduleId);
  try {
    registerQqRoutesFromPackage(moduleId);
  } catch (error) {
    // A future package layout change must not take the whole QQ backend down; the account and
    // catalog routes still work, only the recommendation stream reports an empty batch.
    console.warn('[QQ API] recommendation route was not registered:', getErrorMessage(error));
  }
  return loaded;
};

// The package listens on import and reads PORT at config load, so the environment is prepared first
// and restored afterwards to keep the main process environment untouched.
//
// ⚠️ Call this at most once per process. require() caches modules, so a second call would not start
// a second server: it would return the cached module, i.e. the *previous* server bound to the
// *previous* port, while reporting the port passed in this time. Do not add a retry path here
// without first solving the cache (there is no supported way to re-listen on the exported server).
async function startQqApi(options = {}) {
  const {
    port,
    stateFilePath,
    authSessionRepository,
    moduleId = QQ_API_MODULE,
    loadModule = defaultLoadModule,
    env = process.env,
  } = options;

  if (!port) {
    throw new Error('A port is required to start the QQ API');
  }

  const previous = {
    PORT: env.PORT,
    NODE_ENV: env.NODE_ENV,
    AUTO_OPEN_EXPLORER: env.AUTO_OPEN_EXPLORER,
    QQ_AUTH_STATE_PATH: env.QQ_AUTH_STATE_PATH,
    QQ_DISABLE_UPDATE_CHECK: env.QQ_DISABLE_UPDATE_CHECK,
  };

  const restore = () => {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    });
  };

  env.PORT = String(port);
  env.AUTO_OPEN_EXPLORER = 'false';
  env.QQ_DISABLE_UPDATE_CHECK = 'true';
  if (stateFilePath) {
    env.QQ_AUTH_STATE_PATH = stateFilePath;
  }

  let qqApi;
  try {
    qqApi = loadModule(moduleId);
    if (authSessionRepository) {
      const configureAuthSessionRepository = qqApi && (
        qqApi.configureAuthSessionRepository ||
        (qqApi.default && qqApi.default.configureAuthSessionRepository)
      );
      if (typeof configureAuthSessionRepository !== 'function') {
        throw new Error(
          `QQ API package ${moduleId} does not support auth session persistence`,
        );
      }
      // require() starts the server, but Node cannot accept an HTTP request until this synchronous
      // stack returns. Injecting here restores encrypted credentials before the first status probe.
      configureAuthSessionRepository(authSessionRepository);
    }
  } catch (error) {
    if (isModuleNotFound(error)) {
      const missing = new Error(
        `QQ API package ${moduleId} is not installed. Run: npm install`,
        { cause: error },
      );
      missing.code = 'MODULE_NOT_FOUND';
      throw missing;
    }

    throw error;
  } finally {
    restore();
  }

  const server = qqApi && (qqApi.server || (qqApi.default && qqApi.default.server));
  if (!server || typeof server.once !== 'function') {
    throw new Error(
      `QQ API package ${moduleId} did not expose an HTTP server`,
    );
  }

  await waitUntilListening(server);

  // Once bound, later socket errors must not take the main process down with an unhandled 'error'.
  keepServerErrorsLogged(server, 'QQ API');

  return {
    port,
    stateFilePath: stateFilePath || null,
    server,
    close: () => closeServer(server),
  };
}

module.exports = {
  QQ_API_MODULE,
  getErrorMessage,
  isModuleNotFound,
  startQqApi,
};
