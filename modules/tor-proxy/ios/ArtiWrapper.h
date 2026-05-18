#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^ArtiLogBlock)(NSString *message);
typedef void (^ArtiCompletedBlock)(void);

NS_SWIFT_NAME(ArtiWrapper)
@interface ArtiWrapper : NSObject

/// Start Arti with the given parameters. The completed block fires when
/// "directory is complete" appears in the log, meaning the SOCKS proxy is ready.
/// Call from a background thread — start_arti blocks until Arti exits.
+ (void)startWithStateDir:(NSString *)stateDir
                 cacheDir:(NSString *)cacheDir
                socksPort:(int)socksPort
                 logBlock:(nullable ArtiLogBlock)logBlock
                completed:(nullable ArtiCompletedBlock)completed;

/// Stop Arti. The stoppedBlock fires when Arti has fully shut down
/// (state changed to "Stopped"), so it's safe to call start again.
+ (void)stopWithCompletion:(nullable void (^)(void))stoppedBlock;

+ (void)stop;

@end

NS_ASSUME_NONNULL_END