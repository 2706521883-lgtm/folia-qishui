#!/usr/bin/env node
// dev/mobile/patch-ios-node.mjs
//
// 把 nodejs-mobile 内置服务端接进 Capacitor 生成的 iOS 壳（只动生成目录 ios/，不进仓库）：
//
//   1. 复制 FoliaNode.h/.m 与 Swift 桥接头到 ios/App/App/
//   2. AppDelegate.didFinishLaunching 里调用 FoliaNodeStart()（后台线程启动 Node）
//   3. project.pbxproj 增加：
//        - FoliaNode.m 到 Sources
//        - NodeMobile.framework 到 Frameworks / Embed Frameworks
//        - SWIFT_OBJC_BRIDGING_HEADER / FRAMEWORK_SEARCH_PATHS
//
// 前置：NodeMobile.framework 已解压到 ios/App/App/NodeMobile.framework。
// 用法：node dev/mobile/patch-ios-node.mjs [ios 目录，默认 ios]
//
// 幂等；锚点对不上会直接抛错，避免 CI 静默产出一个没有内置服务端的包。

import fs from 'node:fs';
import path from 'node:path';

const IOS_DIR = path.resolve(process.argv[2] ?? 'ios');
const APP_DIR = path.join(IOS_DIR, 'App', 'App');
const PROJECT_FILE = path.join(IOS_DIR, 'App', 'App.xcodeproj', 'project.pbxproj');
const APP_DELEGATE = path.join(APP_DIR, 'AppDelegate.swift');
const FRAMEWORK_DIR = path.join(APP_DIR, 'NodeMobile.framework');
const TEMPLATE_DIR = path.resolve('mobile', 'ios');

const ID = {
  fileRefM: 'AA0000000000000000000001',
  buildFileM: 'AA0000000000000000000002',
  fileRefFramework: 'AA0000000000000000000003',
  buildFileFramework: 'AA0000000000000000000004',
  buildFileEmbed: 'AA0000000000000000000005',
  phaseEmbed: 'AA0000000000000000000006',
  fileRefH: 'AA0000000000000000000007',
  fileRefBridging: 'AA0000000000000000000008',
};

const fail = message => { throw new Error(message); };

const copyTemplate = name => {
  const source = path.join(TEMPLATE_DIR, name);
  const target = path.join(APP_DIR, name);
  if (!fs.existsSync(source)) fail(`模板缺失：${source}`);
  fs.copyFileSync(source, target);
};

const patchAppDelegate = () => {
  if (!fs.existsSync(APP_DELEGATE)) fail(`找不到 ${APP_DELEGATE} —— 先跑 npx cap add ios`);
  let source = fs.readFileSync(APP_DELEGATE, 'utf8');
  if (source.includes('FoliaNodeStart()')) {
    console.log('[patch-ios-node] AppDelegate 已调用 FoliaNodeStart，跳过');
    return;
  }
  const functionStart = source.indexOf('func application(_ application: UIApplication, didFinishLaunchingWithOptions');
  if (functionStart < 0) fail('AppDelegate.swift 结构不符：找不到 didFinishLaunchingWithOptions');
  const bodyStart = source.indexOf('{', functionStart);
  if (bodyStart < 0) fail('AppDelegate.swift 结构不符：didFinishLaunching 没有函数体');
  const returnIndex = source.indexOf('return true', bodyStart);
  if (returnIndex < 0) fail('AppDelegate.swift 结构不符：didFinishLaunching 里找不到 return true');
  source = `${source.slice(0, returnIndex)}FoliaNodeStart()\n        ${source.slice(returnIndex)}`;
  fs.writeFileSync(APP_DELEGATE, source, 'utf8');
  if (!fs.readFileSync(APP_DELEGATE, 'utf8').includes('FoliaNodeStart()')) {
    fail('AppDelegate 写回校验失败');
  }
  console.log('[patch-ios-node] 已注入 FoliaNodeStart()');
};

const insertAfter = (source, anchor, addition, label) => {
  if (!source.includes(anchor)) fail(`project.pbxproj 结构不符：找不到 ${label} 锚点`);
  return source.replace(anchor, anchor + addition);
};

const patchProject = () => {
  if (!fs.existsSync(PROJECT_FILE)) fail(`找不到 ${PROJECT_FILE} —— 先跑 npx cap add ios`);
  let source = fs.readFileSync(PROJECT_FILE, 'utf8');

  if (!fs.existsSync(FRAMEWORK_DIR) && process.env.FOLIA_NODE_ALLOW_MISSING_FRAMEWORK !== '1') {
    fail(`缺少 ${FRAMEWORK_DIR}（先下载 nodejs-mobile iOS 包并解压）`);
  }

  if (source.includes('/* FoliaNode.m */') || source.includes('/* FoliaNode.m in Sources */')) {
    console.log('[patch-ios-node] project.pbxproj 已包含 FoliaNode，跳过');
    return;
  }

  source = insertAfter(source, '/* Begin PBXBuildFile section */\n', [
    `\t\t${ID.buildFileM} /* FoliaNode.m in Sources */ = {isa = PBXBuildFile; fileRef = ${ID.fileRefM} /* FoliaNode.m */; };`,
    `\t\t${ID.buildFileFramework} /* NodeMobile.framework in Frameworks */ = {isa = PBXBuildFile; fileRef = ${ID.fileRefFramework} /* NodeMobile.framework */; };`,
    `\t\t${ID.buildFileEmbed} /* NodeMobile.framework in Embed Frameworks */ = {isa = PBXBuildFile; fileRef = ${ID.fileRefFramework} /* NodeMobile.framework */; settings = {ATTRIBUTES = (CodeSignOnCopy, RemoveHeadersOnCopy, ); }; };`,
    '',
  ].join('\n'), 'PBXBuildFile');

  source = insertAfter(source, '/* Begin PBXFileReference section */\n', [
    `\t\t${ID.fileRefM} /* FoliaNode.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = FoliaNode.m; sourceTree = "<group>"; };`,
    `\t\t${ID.fileRefH} /* FoliaNode.h */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.h; path = FoliaNode.h; sourceTree = "<group>"; };`,
    `\t\t${ID.fileRefBridging} /* FoliaNodeBridgingHeader.h */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.h; path = FoliaNodeBridgingHeader.h; sourceTree = "<group>"; };`,
    `\t\t${ID.fileRefFramework} /* NodeMobile.framework */ = {isa = PBXFileReference; lastKnownFileType = wrapper.framework; path = NodeMobile.framework; sourceTree = "<group>"; };`,
    '',
  ].join('\n'), 'PBXFileReference');

  // App group：把源码与 framework 放进 App/ 组，路径才会相对 ios/App/App。
  source = insertAfter(source,
    '\t\t\t\t504EC3071FED79650016851F /* AppDelegate.swift */,\n',
    [
      `\t\t\t\t${ID.fileRefM} /* FoliaNode.m */,`,
      `\t\t\t\t${ID.fileRefH} /* FoliaNode.h */,`,
      `\t\t\t\t${ID.fileRefBridging} /* FoliaNodeBridgingHeader.h */,`,
      `\t\t\t\t${ID.fileRefFramework} /* NodeMobile.framework */,`,
    ].join('\n') + '\n',
    'AppDelegate.swift group');

  // Frameworks build phase。
  source = insertAfter(source,
    '\t\t\t\t4D22ABE92AF431CB00220026 /* CapApp-SPM in Frameworks */,\n',
    `\t\t\t\t${ID.buildFileFramework} /* NodeMobile.framework in Frameworks */,\n`,
    'CapApp-SPM in Frameworks');

  // Sources build phase。
  source = insertAfter(source,
    '\t\t\t\t504EC3081FED79650016851F /* AppDelegate.swift in Sources */,\n',
    `\t\t\t\t${ID.buildFileM} /* FoliaNode.m in Sources */,\n`,
    'AppDelegate.swift in Sources');

  // Native target：把 Embed Frameworks 加进 buildPhases。
  source = insertAfter(source,
    '\t\t\t\t504EC3021FED79650016851F /* Resources */,\n',
    `\t\t\t\t${ID.phaseEmbed} /* Embed Frameworks */,\n`,
    'Resources build phase');

  // 新增 PBXCopyFilesBuildPhase 段。
  const copyPhase = [
    '/* Begin PBXCopyFilesBuildPhase section */',
    `\t\t${ID.phaseEmbed} /* Embed Frameworks */ = {`,
    '\t\t\tisa = PBXCopyFilesBuildPhase;',
    '\t\t\tbuildActionMask = 2147483647;',
    '\t\t\tdstPath = "";',
    '\t\t\tdstSubfolderSpec = 10;',
    '\t\t\tfiles = (',
    `\t\t\t\t${ID.buildFileEmbed} /* NodeMobile.framework in Embed Frameworks */,`,
    '\t\t\t);',
    '\t\t\tname = "Embed Frameworks";',
    '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
    '\t\t};',
    '/* End PBXCopyFilesBuildPhase section */',
    '',
    '',
  ].join('\n');
  const variantAnchor = '/* Begin PBXVariantGroup section */';
  if (!source.includes(variantAnchor)) fail('project.pbxproj 结构不符：找不到 PBXVariantGroup 段');
  source = source.replace(variantAnchor, copyPhase + variantAnchor);

  // 目标级 build settings：桥接头 + framework 搜索路径。
  const infoAnchor = '\t\t\t\tINFOPLIST_FILE = App/Info.plist;\n';
  const count = source.split(infoAnchor).length - 1;
  if (count !== 2) fail(`project.pbxproj 结构不符：INFOPLIST_FILE 出现 ${count} 次（预期 2 次）`);
  const settings = [
    '\t\t\t\tFRAMEWORK_SEARCH_PATHS = (',
    '\t\t\t\t\t"$(inherited)",',
    '\t\t\t\t\t"$(PROJECT_DIR)/App",',
    '\t\t\t\t);',
    '\t\t\t\tSWIFT_OBJC_BRIDGING_HEADER = "App/FoliaNodeBridgingHeader.h";',
    '',
  ].join('\n');
  source = source.replaceAll(infoAnchor, infoAnchor + settings);

  fs.writeFileSync(PROJECT_FILE, source, 'utf8');
  const written = fs.readFileSync(PROJECT_FILE, 'utf8');
  for (const needle of ['FoliaNode.m in Sources', 'NodeMobile.framework in Embed Frameworks',
    'SWIFT_OBJC_BRIDGING_HEADER', 'PBXCopyFilesBuildPhase']) {
    if (!written.includes(needle)) fail(`project.pbxproj 写回校验失败：缺 "${needle}"`);
  }
  console.log('[patch-ios-node] 已注入 NodeMobile.framework / FoliaNode.m / 桥接头');
};

const main = () => {
  fs.mkdirSync(APP_DIR, { recursive: true });
  copyTemplate('FoliaNode.h');
  copyTemplate('FoliaNode.m');
  copyTemplate('FoliaNodeBridgingHeader.h');
  patchAppDelegate();
  patchProject();
  console.log('[patch-ios-node] done');
};

main();
