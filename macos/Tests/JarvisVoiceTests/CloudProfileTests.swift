import CryptoKit
import Foundation
import XCTest
@testable import Jarvis

final class CloudProfileTests: XCTestCase {
    private var profile: PairedCloudProfile {
        PairedCloudProfile(version: 1, id: "profile-1", origin: "https://cloud.example.com", deviceId: "device-1",
            label: "This Mac", generation: 1, receiptPublicKey: "fixture-public-key", pairedAt: "2026-11-09T00:00:00Z")
    }
    private func command(id: String = "command-1", sequence: Int = 1, epoch: Int = 4, job: String = "job-1") throws -> CloudCommandEnvelope {
        let payload: [String: Any] = ["kind": "work.cancel", "projectId": "project-1", "jobId": job]
        var bound: [String: Any] = ["deviceId": profile.deviceId, "generation": profile.generation, "serverEpoch": epoch,
            "payload": payload, "expiresAt": "2099-11-09T00:00:00.000Z"]
        let data = try JSONSerialization.data(withJSONObject: bound, options: [.sortedKeys, .withoutEscapingSlashes])
        bound.merge(["version": 1, "type": "command", "id": id, "sequence": sequence, "createdAt": "2026-11-09T00:00:00.000Z", "status": "sent",
            "digest": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()]) { _, right in right }
        return try CloudCommandEnvelope(bound, profile: profile, epoch: epoch)
    }
    func testCloudOriginsRequireTLSAndNeverCarryUserCredentialsOrRetargetPaths() throws {
        XCTAssertEqual(try CloudProfilePolicy.origin("https://cloud.example.com/").absoluteString, "https://cloud.example.com")
        for raw in ["http://cloud.example.com", "https://user:secret@cloud.example.com", "https://cloud.example.com/v1/state", "https://cloud.example.com?token=private", "https://cloud.example.com#token"] {
            XCTAssertThrowsError(try CloudProfilePolicy.origin(raw))
        }
        XCTAssertFalse(CloudProfilePolicy.identifier("../other-profile"))
        XCTAssertTrue(CloudProfilePolicy.identifier("profile-1"))
    }
    func testCloudCommandsBindExactDeviceGenerationEpochAndDigest() throws {
        let value = try command()
        for field in ["deviceId", "generation", "serverEpoch", "digest"] {
            var changed = value.object
            if field == "generation" || field == "serverEpoch" { changed[field] = 999 }
            else { changed[field] = "different" }
            XCTAssertThrowsError(try CloudCommandEnvelope(changed, profile: profile, epoch: 4))
        }
        var changed = value.object; changed["payload"] = ["kind": "work.cancel", "projectId": "other", "jobId": "job-1"]
        XCTAssertThrowsError(try CloudCommandEnvelope(changed, profile: profile, epoch: 4))
    }
    @MainActor
    func testReceiptPreparedBeforeDispatchSurvivesRestartWithoutReplayAndRefusesRetargeting() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = try CloudReceiptJournal(profileID: profile.id, directory: directory)
        let prepared = try first.prepare(command())
        XCTAssertTrue(prepared.dispatch); XCTAssertEqual(prepared.receipt.status, "unknown")
        let restarted = try CloudReceiptJournal(profileID: profile.id, directory: directory)
        let repeated = try restarted.prepare(command())
        XCTAssertFalse(repeated.dispatch); XCTAssertEqual(repeated.receipt, prepared.receipt)
        XCTAssertThrowsError(try restarted.prepare(command(job: "different-job")))
        let complete = try repeated.receipt.resolved(status: "completed", code: "ok")
        try restarted.finish(complete)
        let reopened = try CloudReceiptJournal(profileID: profile.id, directory: directory)
        XCTAssertEqual(try reopened.prepare(command()).receipt, complete)
        XCTAssertThrowsError(try reopened.prepare(command(id: "older", epoch: 3)))
    }
    @MainActor
    func testFailedReceiptPersistenceDoesNotConsumeOrDispatchACommand() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let blocked = directory.appendingPathComponent(profile.id)
        try Data("not-a-directory".utf8).write(to: blocked)
        let journal = try CloudReceiptJournal(profileID: profile.id, directory: directory)
        XCTAssertThrowsError(try journal.prepare(command()))
        try FileManager.default.removeItem(at: blocked)
        XCTAssertTrue(try journal.prepare(command()).dispatch)
    }
    @MainActor
    func testProfileSelectionLeavesLocalAuthorityAndHistoryUnchanged() throws {
        let name = "CloudProfiles-\(UUID().uuidString)", defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let profiles = RuntimeProfiles(defaults: defaults, directory: directory)
        let base = RuntimeConnection.baseURL, local = RuntimeConnection.localToken, native = RuntimeConnection.nativeToken
        try profiles.save(profile)
        XCTAssertEqual(profiles.cloudProfile?.id, profile.id)
        XCTAssertEqual(RuntimeConnection.baseURL, base); XCTAssertEqual(RuntimeConnection.localToken, local); XCTAssertEqual(RuntimeConnection.nativeToken, native)
        try profiles.remove()
        XCTAssertEqual(profiles.selected, .local); XCTAssertNil(profiles.cloudProfile)
    }
}
