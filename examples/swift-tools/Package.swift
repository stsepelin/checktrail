// swift-tools-version: 6.2
import PackageDescription
let package = Package(name: "OriginalQuantity", products: [.library(name: "OriginalQuantity", targets: ["OriginalQuantity"])], targets: [.target(name: "OriginalQuantity"), .testTarget(name: "OriginalQuantityTests", dependencies: ["OriginalQuantity"])])
