import ApplicationServices
import XCTest
@testable import JarvisControl

final class AccessibilityTests: XCTestCase {
    func testSuccessfulDescriptionIsPreserved() throws {
        let value = try checkedAttributeValue("A fixture control" as CFString, name: kAXDescriptionAttribute, status: .success)
        XCTAssertEqual(value as? String, "A fixture control")
    }

    func testFailedOptionalDescriptionIsUnavailable() throws {
        XCTAssertNil(try checkedAttributeValue(nil, name: kAXDescriptionAttribute, status: .failure))
    }

    func testUnsupportedAndAbsentAttributesRemainUnavailable() throws {
        for status in [AXError.noValue, .attributeUnsupported] {
            XCTAssertNil(try checkedAttributeValue(nil, name: kAXDescriptionAttribute, status: status))
            XCTAssertNil(try checkedAttributeValue(nil, name: kAXValueAttribute, status: status))
        }
    }

    func testFailureOfIdentityOrSafetyAttributesStillRefusesInspection() {
        let names = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute,
                     kAXIdentifierAttribute, kAXEnabledAttribute, kAXPositionAttribute, kAXSizeAttribute,
                     kAXFocusedUIElementAttribute, "AXDescriptionUnexpected"]
        for name in names {
            XCTAssertThrowsError(try checkedAttributeValue(nil, name: name, status: .failure)) { error in
                XCTAssertEqual((error as? ControlFailure)?.code, "AX_UNAVAILABLE")
            }
        }
    }

    func testPermissionInvalidElementAndTransportErrorsAreNeverHidden() {
        for status in [AXError.apiDisabled, .invalidUIElement, .cannotComplete, .illegalArgument, .notImplemented] {
            XCTAssertThrowsError(try checkedAttributeValue(nil, name: kAXDescriptionAttribute, status: status))
        }
    }

    func testFailureReportsAttributeAndStatusWithoutContent() {
        XCTAssertThrowsError(try checkedAttributeValue("PRIVATE FIXTURE" as CFString, name: kAXValueAttribute, status: .cannotComplete)) { error in
            let message = (error as? ControlFailure)?.message ?? ""
            XCTAssertTrue(message.contains(kAXValueAttribute))
            XCTAssertTrue(message.contains(String(AXError.cannotComplete.rawValue)))
            XCTAssertFalse(message.contains("PRIVATE FIXTURE"))
        }
    }
}
