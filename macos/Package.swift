// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "JarvisRoy",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "Jarvis", targets: ["Jarvis"])],
    targets: [
        .executableTarget(name: "Jarvis"),
        .testTarget(name: "JarvisVoiceTests", dependencies: ["Jarvis"])
    ]
)
