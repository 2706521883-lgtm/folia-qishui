import type { CapacitorConfig } from '@capacitor/cli';

// 手机壳（Capacitor）配置。桌面 Electron / 网页构建完全不走这个文件。
//
// 壳里网页以 https://localhost（Android）/ capacitor://localhost（iOS）加载；三个在线音源
// 后端走局域网 http，所以：allowMixedContent 打开（https 页面里发 http 请求），Android 清单的
// usesCleartextTraffic 由 CI 在生成平台目录后改为 true（见 .github/workflows/mobile-build.yml）。
// 服务地址在 .env.mobile（npm run build:mobile 读取）。
const config: CapacitorConfig = {
  appId: 'top.izuna.foliamajor',
  appName: 'Folia',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
