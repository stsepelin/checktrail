import XCTest
@testable import OriginalQuantity
final class OriginalQuantityTests: XCTestCase {
    func testZeroBoundary() { XCTAssertEqual(nextQuantity(-1), originalExpectedZero()) }
    func testPositiveBoundary() { XCTAssertEqual(nextQuantity(2), 3) }
}
