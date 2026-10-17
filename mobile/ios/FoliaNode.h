#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// 在后台线程启动 nodejs-mobile，运行 App 内置的 public/nodejs-project/main.js。
/// 会先把工程复制到 Documents/FoliaNode/runtime（仅在 buildId 变化时），
/// 并把 FOLIA_STATE_DIR / FOLIA_LOG_DIR 指向 Documents/FoliaNode。
void FoliaNodeStart(void);

NS_ASSUME_NONNULL_END
