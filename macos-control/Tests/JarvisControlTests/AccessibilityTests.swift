import ApplicationServices
import XCTest
@testable import JarvisControl

final class AccessibilityTests: XCTestCase {
    private var scopeFixture: [(path: [Int], role: String, fingerprint: String)] {
        [([], "AXApplication", "application"), ([0], "AXWindow", "window"),
         ([0, 0], "AXTextArea", "document"), ([1], "AXMenuBar", "menu-bar"),
         ([1, 0], "AXMenuBarItem", "menu-item"), ([1, 0, 0], "AXMenu", "menu")]
    }

    func testMenuChurnDoesNotInvalidateWindowTargets() {
        let before = ObservationDigests(elements: scopeFixture)
        var changed = scopeFixture
        changed[3].fingerprint = "new-menu-children"
        changed[4].fingerprint = "new-enabled-title-and-identifier"
        changed.append(([1, 0, 0, 0], "AXMenuItem", "new-menu-item"))
        let after = ObservationDigests(elements: changed)
        XCTAssertNotEqual(before.tree, after.tree)
        XCTAssertEqual(before.forTarget([0, 0]), after.forTarget([0, 0]))
    }

    func testMenuTargetsRetainFullTreeValidation() {
        let before = ObservationDigests(elements: scopeFixture)
        var changed = scopeFixture
        changed[4].fingerprint = "changed-menu-item"
        let after = ObservationDigests(elements: changed)
        for path in [[1], [1, 0], [1, 0, 0]] {
            XCTAssertEqual(before.forTarget(path), before.tree)
            XCTAssertNotEqual(before.forTarget(path), after.forTarget(path))
        }
    }

    func testWindowAncestorsAndOtherWindowsRemainBound() {
        let before = ObservationDigests(elements: scopeFixture)
        for index in 0...2 {
            var changed = scopeFixture
            changed[index].fingerprint = "changed-identity-geometry-value-or-state"
            XCTAssertNotEqual(before.forTarget([0, 0]), ObservationDigests(elements: changed).forTarget([0, 0]))
        }
        var withModal = scopeFixture
        withModal.append(([2], "AXWindow", "new-modal-window"))
        XCTAssertNotEqual(before.forTarget([0, 0]), ObservationDigests(elements: withModal).forTarget([0, 0]))
    }

    func testNestedMenuDescendantsUseFullTreeEvenWithNonMenuRole() {
        var elements = scopeFixture
        elements.append(([0, 1], "AXMenu", "nested-menu"))
        elements.append(([0, 1, 0], "AXTextField", "menu-search-field"))
        let digests = ObservationDigests(elements: elements)
        XCTAssertEqual(digests.forTarget([0, 1, 0]), digests.tree)
        XCTAssertEqual(digests.forTarget([0, 0]), digests.content)
        XCTAssertNotEqual(digests.content, digests.tree)
    }

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
