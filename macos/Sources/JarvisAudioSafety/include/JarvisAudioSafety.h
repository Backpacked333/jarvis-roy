#import <AVFoundation/AVFoundation.h>

BOOL JarvisHasAudioInput(void);
BOOL JarvisInstallInputTap(AVAudioEngine * _Nonnull engine, AVAudioNodeTapBlock _Nonnull block);
BOOL JarvisStartAudioEngine(AVAudioEngine * _Nonnull engine);
void JarvisStopAudioEngine(AVAudioEngine * _Nonnull engine, BOOL removeTap);

BOOL JarvisHasAudioOutput(void);
BOOL JarvisConfigurePlayback(AVAudioEngine * _Nonnull engine, AVAudioPlayerNode * _Nonnull player, AVAudioNodeTapBlock _Nonnull block);
BOOL JarvisSchedulePlayback(AVAudioPlayerNode * _Nonnull player, AVAudioPCMBuffer * _Nonnull buffer, void (^ _Nonnull completion)(void));
void JarvisStopPlayback(AVAudioEngine * _Nonnull engine, AVAudioPlayerNode * _Nonnull player, BOOL removeTap);

@interface JarvisPCMConverter : NSObject
@property(nonatomic, readonly) NSInteger failureCode;
- (NSData * _Nullable)convertBuffer:(AVAudioPCMBuffer * _Nonnull)buffer NS_RETURNS_RETAINED NS_SWIFT_NAME(convert(_:));
@end
