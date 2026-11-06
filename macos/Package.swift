// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "JarvisRoy",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Jarvis", targets: ["Jarvis"])],
    targets: [
        .target(name: "JarvisAudioSafety", linkerSettings: [.linkedFramework("AVFoundation"), .linkedFramework("CoreAudio")]),
        .executableTarget(name: "Jarvis", dependencies: ["JarvisAudioSafety"], exclude: ["Rooms/README.md"]),
        .testTarget(name: "JarvisVoiceTests", dependencies: ["Jarvis"])
    ]
)
