#import "ArtiWrapper.h"
#import <arti/arti-mobile.h>

static ArtiLogBlock _logBlock;
static ArtiCompletedBlock _completedBlock;

static void artiLoggingCb(const char *message) {
    if (!message) return;

    NSMutableString *msg = [[NSMutableString alloc] initWithUTF8String:message];

    // Detect bootstrap completion
    if (_completedBlock && [msg.lowercaseString containsString:@"directory is complete"]) {
        dispatch_async(dispatch_get_main_queue(), ^{
            if (_completedBlock) {
                _completedBlock();
                _completedBlock = nil;
            }
        });
    }

    // Forward to log block
    if (_logBlock) {
        _logBlock(msg);
    }
}

@implementation ArtiWrapper

+ (void)startWithStateDir:(NSString *)stateDir
                 cacheDir:(NSString *)cacheDir
                socksPort:(int)socksPort
                 logBlock:(nullable ArtiLogBlock)logBlock
                completed:(nullable ArtiCompletedBlock)completed {
    _logBlock = logBlock;
    _completedBlock = completed;

    // Write config that enables onion service client and set ARTI_CONFIG env var
    // so Arti finds it. Arti doesn't read config from stateDir automatically.
    NSString *configDir = [stateDir stringByAppendingPathComponent:@"config"];
    [[NSFileManager defaultManager] createDirectoryAtPath:configDir withIntermediateDirectories:YES attributes:nil error:nil];

    NSString *configPath = [configDir stringByAppendingPathComponent:@"arti.toml"];
    NSString *config = [NSString stringWithFormat:
        @"[address_filter]\nallow_onion_addrs = true\n\n"
        @"[storage]\nstate_dir = \"%@\"\ncache_dir = \"%@\"\n\n"
        @"[storage.permissions]\ndangerously_trust_everyone = true\n",
        stateDir, cacheDir];
    [config writeToFile:configPath atomically:YES encoding:NSUTF8StringEncoding error:nil];

    setenv("ARTI_CONFIG", [configPath UTF8String], 1);
#ifdef DEBUG
    NSLog(@"[ArtiWrapper] Config written to %@ and ARTI_CONFIG set", configPath);
#endif

    start_arti(
        [stateDir cStringUsingEncoding:NSUTF8StringEncoding],
        [cacheDir cStringUsingEncoding:NSUTF8StringEncoding],
        0,    // obfs4_port
        0,    // snowflake_port
        NULL, // obfs4proxy_path
        NULL, // bridge_line
        socksPort,
        0,    // dns_port
        &artiLoggingCb
    );
}

+ (void)stop {
    _completedBlock = nil;
    _logBlock = nil;
    stop_arti();
}

@end