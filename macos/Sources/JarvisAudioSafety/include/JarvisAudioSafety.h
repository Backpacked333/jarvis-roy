#import <AVFoundation/AVFoundation.h>

BOOL JarvisHasAudioInput(void);
BOOL JarvisInstallInputTap(AVAudioEngine * _Nonnull engine, AVAudioNodeTapBlock _Nonnull block);
BOOL JarvisStartAudioEngine(AVAudioEngine * _Nonnull engine);
void JarvisStopAudioEngine(AVAudioEngine * _Nonnull engine, BOOL removeTap);
