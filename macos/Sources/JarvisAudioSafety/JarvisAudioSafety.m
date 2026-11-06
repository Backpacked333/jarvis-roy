#import "JarvisAudioSafety.h"
#import <CoreAudio/CoreAudio.h>
#include <stddef.h>
#include <stdlib.h>
#include <math.h>
#include <stdint.h>

BOOL JarvisHasAudioInput(void) {
    AudioDeviceID device = kAudioObjectUnknown;
    UInt32 size = sizeof(device);
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device) != noErr || device == kAudioObjectUnknown) return NO;
    UInt32 alive = 0;
    size = sizeof(alive);
    address.mSelector = kAudioDevicePropertyDeviceIsAlive;
    if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &alive) != noErr || !alive) return NO;
    address.mSelector = kAudioDevicePropertyStreamConfiguration;
    address.mScope = kAudioDevicePropertyScopeInput;
    if (AudioObjectGetPropertyDataSize(device, &address, 0, NULL, &size) != noErr || size < sizeof(AudioBufferList) || size > 1048576) return NO;
    UInt32 capacity = size;
    AudioBufferList *buffers = calloc(1, capacity);
    if (!buffers) return NO;
    BOOL available = NO;
    if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, buffers) == noErr && size >= offsetof(AudioBufferList, mBuffers) && size <= capacity &&
        buffers->mNumberBuffers <= (size - offsetof(AudioBufferList, mBuffers)) / sizeof(AudioBuffer)) {
        for (UInt32 index = 0; index < buffers->mNumberBuffers; index++) available |= buffers->mBuffers[index].mNumberChannels > 0;
    }
    free(buffers);
    return available;
}

BOOL JarvisInstallInputTap(AVAudioEngine *engine, AVAudioNodeTapBlock block) {
    AVAudioInputNode *input = nil;
    // AVFAudio throws Objective-C exceptions for invalid/disconnected hardware; Swift catch cannot handle them.
    @try {
        if (!JarvisHasAudioInput()) return NO;
        input = engine.inputNode;
        AVAudioFormat *hardware = [input inputFormatForBus:0];
        AVAudioFormat *output = [input outputFormatForBus:0];
        if (hardware.sampleRate <= 0 || hardware.channelCount == 0 || output.sampleRate != hardware.sampleRate || output.channelCount != hardware.channelCount) return NO;
        [input installTapOnBus:0 bufferSize:1024 format:nil block:block];
        return YES;
    } @catch (NSException *exception) {
        @try { [input removeTapOnBus:0]; } @catch (NSException *cleanupException) {}
        return NO;
    }
}

BOOL JarvisStartAudioEngine(AVAudioEngine *engine) {
    @try {
        [engine prepare];
        return [engine startAndReturnError:nil];
    } @catch (NSException *exception) {
        return NO;
    }
}

void JarvisStopAudioEngine(AVAudioEngine *engine, BOOL removeTap) {
    @try { [engine stop]; } @catch (NSException *exception) {}
    if (removeTap) {
        @try { [engine.inputNode removeTapOnBus:0]; } @catch (NSException *exception) {}
    }
}

BOOL JarvisHasAudioOutput(void) {
    AudioDeviceID device = kAudioObjectUnknown;
    UInt32 size = sizeof(device);
    AudioObjectPropertyAddress address = { kAudioHardwarePropertyDefaultOutputDevice, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
    if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, NULL, &size, &device) != noErr || device == kAudioObjectUnknown) return NO;
    UInt32 alive = 0;
    address.mSelector = kAudioDevicePropertyDeviceIsAlive;
    size = sizeof(alive);
    if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, &alive) != noErr || !alive) return NO;
    address.mSelector = kAudioDevicePropertyStreamConfiguration;
    address.mScope = kAudioDevicePropertyScopeOutput;
    if (AudioObjectGetPropertyDataSize(device, &address, 0, NULL, &size) != noErr || size < sizeof(AudioBufferList) || size > 1048576) return NO;
    UInt32 capacity = size;
    AudioBufferList *buffers = calloc(1, capacity);
    if (!buffers) return NO;
    BOOL available = NO;
    if (AudioObjectGetPropertyData(device, &address, 0, NULL, &size, buffers) == noErr && size >= offsetof(AudioBufferList, mBuffers) && size <= capacity &&
        buffers->mNumberBuffers <= (size - offsetof(AudioBufferList, mBuffers)) / sizeof(AudioBuffer)) {
        for (UInt32 index = 0; index < buffers->mNumberBuffers; index++) available |= buffers->mBuffers[index].mNumberChannels > 0;
    }
    free(buffers);
    return available;
}

BOOL JarvisConfigurePlayback(AVAudioEngine *engine, AVAudioPlayerNode *player, AVAudioNodeTapBlock block) {
    @autoreleasepool {
        @try {
            if (!JarvisHasAudioOutput()) return NO;
            AVAudioFormat *hardware = [engine.outputNode outputFormatForBus:0];
            if (hardware.sampleRate <= 0 || hardware.channelCount == 0) return NO;
            if (player.engine != engine) [engine attachNode:player];
            AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:24000 channels:1 interleaved:NO];
#if !__has_feature(objc_arc)
            [format autorelease];
#endif
            [engine connect:player to:engine.mainMixerNode format:format];
            [engine.mainMixerNode installTapOnBus:0 bufferSize:1024 format:nil block:block];
            return YES;
        } @catch (NSException *exception) {
            @try { [engine.mainMixerNode removeTapOnBus:0]; } @catch (NSException *cleanupException) {}
            return NO;
        }
    }
}

BOOL JarvisSchedulePlayback(AVAudioPlayerNode *player, AVAudioPCMBuffer *buffer, void (^completion)(void)) {
    @try {
        [player scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType type) { completion(); }];
        if (!player.isPlaying) [player play];
        return YES;
    } @catch (NSException *exception) { return NO; }
}

void JarvisStopPlayback(AVAudioEngine *engine, AVAudioPlayerNode *player, BOOL removeTap) {
    @try { [player stop]; } @catch (NSException *exception) {}
    @try { [engine stop]; } @catch (NSException *exception) {}
    if (removeTap) {
        @try { [engine.mainMixerNode removeTapOnBus:0]; } @catch (NSException *exception) {}
    }
}

BOOL JarvisDuplexIsHealthy(AVAudioEngine *engine) {
    @try {
        return JarvisHasAudioInput() && JarvisHasAudioOutput() && engine.isRunning &&
            engine.inputNode.isVoiceProcessingEnabled && engine.outputNode.isVoiceProcessingEnabled &&
            !engine.inputNode.isVoiceProcessingBypassed && !engine.inputNode.isVoiceProcessingInputMuted;
    } @catch (NSException *exception) { return NO; }
}

BOOL JarvisConfigureDuplex(AVAudioEngine *engine, AVAudioPlayerNode *player, AVAudioNodeTapBlock input, AVAudioNodeTapBlock output) {
    @try {
        if (engine.isRunning || !JarvisHasAudioInput() || !JarvisHasAudioOutput()) return NO;
        NSError *error = nil;
        // AEC needs both I/O nodes in the SAME engine; a separate playback engine is not a reference.
        if (![engine.inputNode setVoiceProcessingEnabled:YES error:&error] || error) return NO;
        engine.inputNode.voiceProcessingBypassed = NO;
        engine.inputNode.voiceProcessingInputMuted = NO;
        if (!engine.inputNode.isVoiceProcessingEnabled || !engine.outputNode.isVoiceProcessingEnabled) return NO;
        AVAudioFormat *format = [engine.inputNode outputFormatForBus:0];
        // Refuse unexpected multichannel voice-processing layouts rather than mix an echo reference into speech.
        if (format.channelCount != 1 || format.sampleRate < 8000 || format.sampleRate > 192000) return NO;
        if (!JarvisConfigurePlayback(engine, player, output)) return NO;
        [engine.inputNode installTapOnBus:0 bufferSize:1024 format:nil block:input];
        return YES;
    } @catch (NSException *exception) { return NO; }
}

void JarvisStopPlayer(AVAudioPlayerNode *player) {
    @try { [player stop]; } @catch (NSException *exception) {}
}

@implementation JarvisPCMConverter {
    AVAudioConverter *_converter;
    AVAudioFormat *_source;
}
- (NSData *)convertBuffer:(AVAudioPCMBuffer *)buffer {
    @autoreleasepool {
        @try {
            AVAudioFormat *format = buffer.format;
            if (format.sampleRate < 8000 || format.sampleRate > 192000 || format.channelCount < 1 || format.channelCount > 8 || buffer.frameLength == 0 || buffer.frameLength > 8192) return nil;
            if (_source && ![_source isEqual:format]) return nil;
            if (!_converter) {
                AVAudioFormat *target = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatInt16 sampleRate:16000 channels:1 interleaved:YES];
#if !__has_feature(objc_arc)
                [target autorelease];
#endif
                _converter = [[AVAudioConverter alloc] initFromFormat:format toFormat:target];
                _converter.downmix = YES;
                _source = [format copy];
            }
            if (!_converter) return nil;
            AVAudioFrameCount capacity = (AVAudioFrameCount)ceil(buffer.frameLength * 16000.0 / format.sampleRate) + 32;
            if (capacity > 16384) return nil;
            AVAudioPCMBuffer *output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:_converter.outputFormat frameCapacity:capacity];
#if !__has_feature(objc_arc)
            [output autorelease];
#endif
            __block BOOL supplied = NO;
            NSError *error = nil;
            AVAudioConverterOutputStatus status = [_converter convertToBuffer:output error:&error withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount packets, AVAudioConverterInputStatus *inputStatus) {
                if (supplied) { *inputStatus = AVAudioConverterInputStatus_NoDataNow; return nil; }
                supplied = YES;
                *inputStatus = AVAudioConverterInputStatus_HaveData;
                return buffer;
            }];
            if (error || status == AVAudioConverterOutputStatus_Error || !output.int16ChannelData) return nil;
            return [[NSData alloc] initWithBytes:output.int16ChannelData[0] length:output.frameLength * sizeof(int16_t)];
        } @catch (NSException *exception) { return nil; }
    }
}
- (void)dealloc {
#if !__has_feature(objc_arc)
    [_converter release];
    [_source release];
    [super dealloc];
#endif
}
@end
