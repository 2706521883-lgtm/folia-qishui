#import "FoliaNode.h"

#import <NodeMobile/NodeMobile.h>
#import <Foundation/Foundation.h>
#import <dispatch/dispatch.h>
#import <stdlib.h>

// argv 必须活到 node_start 之后；Node 启动期会读它。
static char *foliaNodeArgv[3];
static char foliaNodeArg0[] = "node";

static void FoliaNodeLog(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    NSLog(@"[FoliaNode] %@", message);
    NSString *stateDir = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
    if (!stateDir) return;
    NSString *logFile = [stateDir stringByAppendingPathComponent:@"folia-node-native.log"];
    NSString *line = [NSString stringWithFormat:@"[%@] %@\n", [NSDate date], message];
    @try {
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:logFile];
        if (!handle) {
            [line writeToFile:logFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
        } else {
            [handle seekToEndOfFile];
            [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
            [handle closeFile];
        }
    } @catch (__unused NSException *exception) {
        // 日志失败不能影响启动。
    }
}

static BOOL FoliaCopyTree(NSString *source, NSString *target) {
    NSFileManager *manager = [NSFileManager defaultManager];
    NSError *error = nil;
    if (![manager createDirectoryAtPath:target withIntermediateDirectories:YES attributes:nil error:&error]) {
        FoliaNodeLog(@"create dir failed %@: %@", target, error);
        return NO;
    }
    NSArray<NSString *> *items = [manager contentsOfDirectoryAtPath:source error:&error];
    if (!items) {
        FoliaNodeLog(@"list dir failed %@: %@", source, error);
        return NO;
    }
    for (NSString *item in items) {
        // .bin 里全是 npm 生成的相对软链，Node 运行期用不到，App 包里还可能断链。
        if ([item isEqualToString:@".bin"]) continue;
        NSString *from = [source stringByAppendingPathComponent:item];
        NSString *to = [target stringByAppendingPathComponent:item];
        BOOL isDirectory = NO;
        if (![manager fileExistsAtPath:from isDirectory:&isDirectory]) continue;
        if (isDirectory) {
            if (!FoliaCopyTree(from, to)) return NO;
        } else {
            [manager removeItemAtPath:to error:nil];
            if (![manager copyItemAtPath:from toPath:to error:&error]) {
                FoliaNodeLog(@"copy failed %@ -> %@: %@", from, to, error);
                return NO;
            }
        }
    }
    return YES;
}

static NSString *FoliaBundleProjectPath(void) {
    NSFileManager *manager = [NSFileManager defaultManager];
    NSString *resourcePath = [[NSBundle mainBundle] resourcePath];
    NSString *candidate = [resourcePath stringByAppendingPathComponent:@"public/nodejs-project"];
    if ([manager fileExistsAtPath:[candidate stringByAppendingPathComponent:@"main.js"]]) return candidate;
    NSString *fallback = [[NSBundle mainBundle] pathForResource:@"nodejs-project" ofType:nil inDirectory:@"public"];
    if (fallback && [manager fileExistsAtPath:[fallback stringByAppendingPathComponent:@"main.js"]]) return fallback;
    return nil;
}

static NSString *FoliaReadBuildId(NSString *projectPath) {
    NSString *buildFile = [projectPath stringByAppendingPathComponent:@"build.json"];
    NSData *data = [NSData dataWithContentsOfFile:buildFile];
    if (!data) return @"";
    NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![json isKindOfClass:[NSDictionary class]]) return @"";
    id buildId = json[@"buildId"];
    return [buildId isKindOfClass:[NSString class]] ? buildId : @"";
}

static NSString *FoliaPrepareRuntime(NSString *stateDir, NSString *projectPath) {
    NSFileManager *manager = [NSFileManager defaultManager];
    NSString *runtimeDir = [stateDir stringByAppendingPathComponent:@"runtime"];
    NSString *runtimeMain = [runtimeDir stringByAppendingPathComponent:@"main.js"];
    NSString *markerFile = [stateDir stringByAppendingPathComponent:@"runtime-build-id.txt"];
    NSString *buildId = FoliaReadBuildId(projectPath);
    NSString *installedId = [NSString stringWithContentsOfFile:markerFile encoding:NSUTF8StringEncoding error:nil];
    installedId = [installedId stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];

    if ([manager fileExistsAtPath:runtimeMain] && buildId.length > 0 && [installedId isEqualToString:buildId]) {
        return runtimeDir;
    }

    FoliaNodeLog(@"installing node project %@ -> %@", buildId, runtimeDir);
    [manager removeItemAtPath:runtimeDir error:nil];
    if (!FoliaCopyTree(projectPath, runtimeDir)) {
        FoliaNodeLog(@"node project copy failed");
        return nil;
    }
    [buildId writeToFile:markerFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
    return runtimeDir;
}

void FoliaNodeStart(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        NSFileManager *manager = [NSFileManager defaultManager];
        NSString *documents = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES) firstObject];
        if (!documents) {
            FoliaNodeLog(@"no Documents directory; node not started");
            return;
        }
        NSString *stateDir = [documents stringByAppendingPathComponent:@"FoliaNode"];
        [manager createDirectoryAtPath:stateDir withIntermediateDirectories:YES attributes:nil error:nil];

        NSString *projectPath = FoliaBundleProjectPath();
        if (!projectPath) {
            FoliaNodeLog(@"public/nodejs-project missing from app bundle");
            return;
        }

        setenv("FOLIA_STATE_DIR", [stateDir fileSystemRepresentation], 1);
        setenv("FOLIA_LOG_DIR", [stateDir fileSystemRepresentation], 1);
        setenv("NODE_NO_WARNINGS", "1", 1);

        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            @autoreleasepool {
                NSString *runtimeDir = FoliaPrepareRuntime(stateDir, projectPath);
                if (!runtimeDir) return;
                NSString *mainScript = [runtimeDir stringByAppendingPathComponent:@"main.js"];
                FoliaNodeLog(@"starting node with %@", mainScript);
                foliaNodeArgv[0] = foliaNodeArg0;
                foliaNodeArgv[1] = strdup([mainScript fileSystemRepresentation]);
                foliaNodeArgv[2] = NULL;
                int status = node_start(2, foliaNodeArgv);
                FoliaNodeLog(@"node exited with status %d", status);
            }
        });
    });
}
