#import "JarvisAudioSafety.h"
#import <CoreAudio/CoreAudio.h>
#include <stddef.h>
#include <stdlib.h>

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
