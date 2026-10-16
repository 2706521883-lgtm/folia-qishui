#!/usr/bin/env node
// dev/mobile/patch-ios-shell.mjs
//
// 给 Capacitor 生成的 iOS 壳打「后台播放」原生补丁（动的是生成的 ios/ 目录，不进仓库）：
//
//   ios/App/App/AppDelegate.swift
//     ① 注入 FoliaAudioSession —— 音频会话切 AVAudioSession .playback 并激活。
//        iOS 默认类别是 .soloAmbient：一进后台/锁屏就被系统静音，HTMLAudio 直接断，
//        这是「滑出应用就不放了」的直接原因（Capacitor 自身不碰音频会话，全库无引用）。
//     ② 监听打断（来电/闹钟）与拔耳机事件，结束后重新激活会话，恢复播放不会变哑巴。
//
//   Info.plist 的 UIBackgroundModes=[audio] 在 workflow 里用 PlistBuddy 加（不在这里，
//   因为 PlistBuddy 只在 macOS 上有）。两者缺一不可：plist 是「声明能力」，会话类别是「真的走播放通道」。
//
//   node dev/mobile/patch-ios-shell.mjs [ios 目录，默认 ios]
//
// 幂等：已打过（含 FoliaAudioSession 标记）就跳过。锚点对不上直接抛错，让 CI 响亮地失败，
// 避免「以为打了补丁其实没打」的静默降级。

import fs from 'node:fs';
import path from 'node:path';

const IOS_DIR = path.resolve(process.argv[2] ?? 'ios');
const APP_DELEGATE = path.join(IOS_DIR, 'App', 'App', 'AppDelegate.swift');
const MARKER = 'FoliaAudioSession';

const IMPORT_ANCHOR = 'import Capacitor\n';
const LAUNCH_ANCHOR = '    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {\n        // Override point for customization after application launch.\n        return true\n    }\n';

const LAUNCH_PATCHED = `    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Folia 移动壳补丁：会话切 playback（配合 Info.plist 的 UIBackgroundModes: audio）。
        FoliaAudioSession.activate()
        return true
    }
`;

// 附在文件末尾（Swift 文件作用域内声明与顺序无关，AppDelegate 之前之后都行）。
const AUDIO_SESSION_CLASS = `
// ── Folia 移动壳补丁（dev/mobile/patch-ios-shell.mjs 注入，改这里的代码要同步改脚本）──
// 让 WebView 里的 HTMLAudioElement 在后台 / 锁屏继续出声。
final class FoliaAudioSession: NSObject {
    static let shared = FoliaAudioSession()

    // 继承 NSObject：选择器式通知观察者必须是 ObjC 对象（@objc 成员同理）。
    private override init() {
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(handleInterruption(_:)),
                           name: AVAudioSession.interruptionNotification, object: nil)
        center.addObserver(self, selector: #selector(handleRouteChange(_:)),
                           name: AVAudioSession.routeChangeNotification, object: nil)
    }

    /// 启动时调用：类别设为播放并激活会话。
    static func activate() {
        _ = shared
        apply()
    }

    private static func apply() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            NSLog("Folia: AVAudioSession -> .playback, active")
        } catch {
            NSLog("Folia: AVAudioSession 设置失败: \\(error)")
        }
    }

    /// 来电 / 闹钟等打断结束：不重新激活的话，恢复播放是没声音的。
    @objc private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .ended {
            FoliaAudioSession.apply()
        }
    }

    /// 拔耳机（oldDeviceUnavailable）会暂停播放：重新激活，让用户按播放键立刻出声。
    @objc private func handleRouteChange(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        if reason == .oldDeviceUnavailable {
            FoliaAudioSession.apply()
        }
    }
}
`;

const main = () => {
  if (!fs.existsSync(APP_DELEGATE)) {
    throw new Error(`找不到 ${APP_DELEGATE} —— 先跑 npx cap add ios`);
  }
  let source = fs.readFileSync(APP_DELEGATE, 'utf8');

  if (source.includes(MARKER)) {
    console.log(`${APP_DELEGATE} 已打过补丁，跳过`);
    return;
  }
  if (!source.includes(IMPORT_ANCHOR)) {
    throw new Error(`AppDelegate.swift 结构与预期不符（缺 "import Capacitor"）：${APP_DELEGATE}`);
  }
  if (!source.includes(LAUNCH_ANCHOR)) {
    throw new Error(`AppDelegate.swift 结构与预期不符（didFinishLaunchingWithOptions 锚点变了）：${APP_DELEGATE}`);
  }

  source = source.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}import AVFoundation\n`);
  source = source.replace(LAUNCH_ANCHOR, LAUNCH_PATCHED);
  source = `${source.trimEnd()}\n${AUDIO_SESSION_CLASS}`;
  fs.writeFileSync(APP_DELEGATE, source, 'utf8');

  // 写回后复查一遍：宁可在这里炸，也不要在真机上才发现没补上。
  const written = fs.readFileSync(APP_DELEGATE, 'utf8');
  for (const needle of ['import AVFoundation', 'FoliaAudioSession.activate()', 'setCategory(.playback']) {
    if (!written.includes(needle)) throw new Error(`补丁写回后校验失败，缺 "${needle}"：${APP_DELEGATE}`);
  }
  console.log(`已注入后台播放补丁：${APP_DELEGATE}`);
};

main();
