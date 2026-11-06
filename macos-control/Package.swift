// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "JarvisControl",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "JarvisControl", targets: ["JarvisControl"])],
    targets: [.executableTarget(name: "JarvisControl")]
)
