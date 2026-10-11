'use strict';

const fs = require('fs');
const path = require('path');

// electron/qishui/credentials.cjs

// 汽水（Qishui / SodaMusic）四个凭据文件都在 app.getPath('userData') 下，文件名与 Mineradio X 保持一致，
// 便于用同样方式排错；这里刻意不使用 safeStorage，因为协议层（qishui-api.js / qishui-qr-login.js）
// 直接按纯文本读写这些文件，加密后协议层将无法解析。
const QISHUI_CREDENTIAL_FILE_NAMES = Object.freeze({
  cookie: '.qishui-cookie',
  token: '.qishui-token',
  qrConfig: '.qishui-qr-login.json',
  oauthConfig: '.qishui-oauth.json',
});

// 尽力收紧到「仅本人可读」。Windows 上 chmod 基本是空操作（Node 只映射只读位），
// 真正的保护来自 %APPDATA% 的用户目录 ACL，失败时静默跳过即可。
function hardenFilePermissions(file, warn) {
  try {
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if (warn) warn('[QishuiCredentials] failed to restrict permissions for', file, error && error.message);
  }
}

function ensureParentDirectory(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// 解析四个凭据文件的绝对路径。userDataDir 应来自 app.getPath('userData')。
function resolveQishuiCredentialPaths(userDataDir) {
  const root = path.resolve(String(userDataDir || '.'));
  return {
    root,
    cookie: path.join(root, QISHUI_CREDENTIAL_FILE_NAMES.cookie),
    token: path.join(root, QISHUI_CREDENTIAL_FILE_NAMES.token),
    qrConfig: path.join(root, QISHUI_CREDENTIAL_FILE_NAMES.qrConfig),
    oauthConfig: path.join(root, QISHUI_CREDENTIAL_FILE_NAMES.oauthConfig),
  };
}

function readTextFile(file) {
  try {
    if (!file || !fs.existsSync(file)) return '';
    return String(fs.readFileSync(file, 'utf8')).trim();
  } catch (_) {
    return '';
  }
}

function writeTextFile(file, value) {
  if (!file) return false;
  ensureParentDirectory(file);
  fs.writeFileSync(file, String(value == null ? '' : value), 'utf8');
  hardenFilePermissions(file);
  return true;
}

function removeFile(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

function createQishuiCredentials({ userDataDir, warn = console.warn } = {}) {
  const paths = resolveQishuiCredentialPaths(userDataDir);
  // 目录可能尚不存在（首次启动、用户清过配置）。协议层写入时也会 mkdir，这里提前建一次，
  // 让 .qishui-cookie 这类只读路径在读取阶段就有确定的落点。
  ensureParentDirectory(paths.cookie);

  return {
    paths,
    names: QISHUI_CREDENTIAL_FILE_NAMES,
    readText: readTextFile,
    writeText: (file, value) => writeTextFile(file, value),
    removeText: removeFile,
    harden: (file) => hardenFilePermissions(file, warn),
    // cookie 是四个文件里唯一由桥自己负责读写的（token / qr / oauth 由协议层按环境变量路径自理）。
    readCookie: () => readTextFile(paths.cookie),
    writeCookie: (value) => {
      writeTextFile(paths.cookie, value);
      return readTextFile(paths.cookie);
    },
    clearCookie: () => removeFile(paths.cookie),
  };
}

module.exports = {
  QISHUI_CREDENTIAL_FILE_NAMES,
  resolveQishuiCredentialPaths,
  readTextFile,
  writeTextFile,
  removeFile,
  hardenFilePermissions,
  createQishuiCredentials,
};
