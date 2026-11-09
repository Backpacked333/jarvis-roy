import Foundation
import CryptoKit

struct CloudDeviceReceipt: Codable, Equatable {
    let version: Int, type: String, id: String, commandId: String, deviceId: String
    let generation: Int, serverEpoch: Int, commandDigest: String
    let status: String, code: String
    func resolved(status: String, code: String) throws -> Self {
        guard ["completed", "failed", "unknown"].contains(status),
              ["ok", "rejected", "stale", "unavailable", "interrupted", "unknown"].contains(code) else { throw CloudConnectionFailure.protocolMismatch }
        return Self(version: version, type: type, id: id, commandId: commandId, deviceId: deviceId,
            generation: generation, serverEpoch: serverEpoch, commandDigest: commandDigest, status: status, code: code)
    }
}

struct CloudCommandEnvelope {
    let object: [String: Any]
    let id: String, deviceId: String, digest: String, kind: String
    let generation: Int, serverEpoch: Int, sequence: Int, expiresAt: Date
    init(_ object: [String: Any], profile: PairedCloudProfile, epoch: Int) throws {
        guard object["version"] as? Int == 1, object["type"] as? String == "command",
              let id = object["id"] as? String, CloudProfilePolicy.identifier(id),
              let deviceId = object["deviceId"] as? String, deviceId == profile.deviceId,
              let generation = object["generation"] as? Int, generation == profile.generation,
              let serverEpoch = object["serverEpoch"] as? Int, serverEpoch == epoch, serverEpoch > 0,
              let sequence = object["sequence"] as? Int, sequence > 0,
              let digest = object["digest"] as? String, digest.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
              let payload = object["payload"] as? [String: Any], let kind = payload["kind"] as? String,
              ["snapshot.request", "action.execute", "work.cancel"].contains(kind),
              let expires = object["expiresAt"] as? String, let expiry = Self.date(expires),
              let created = object["createdAt"] as? String, let creation = Self.date(created), creation <= expiry,
              ["queued", "sent"].contains(object["status"] as? String ?? "") else { throw CloudConnectionFailure.protocolMismatch }
        let bound: [String: Any] = ["deviceId": deviceId, "generation": generation, "serverEpoch": serverEpoch, "payload": payload, "expiresAt": expires]
        let data = try JSONSerialization.data(withJSONObject: bound, options: [.sortedKeys, .withoutEscapingSlashes])
        guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == digest else { throw CloudConnectionFailure.protocolMismatch }
        self.object = object; self.id = id; self.deviceId = deviceId; self.generation = generation
        self.serverEpoch = serverEpoch; self.sequence = sequence; self.digest = digest; self.kind = kind; expiresAt = expiry
    }
    static func date(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

@MainActor
final class CloudReceiptJournal {
    private struct State: Codable {
        let version: Int
        var epoch: Int, sequence: Int, receipts: [CloudDeviceReceipt]
    }
    private let file: URL
    private var state = State(version: 1, epoch: 0, sequence: 0, receipts: [])
    init(profileID: String, directory: URL = CloudProfilePolicy.directory) throws {
        guard CloudProfilePolicy.identifier(profileID) else { throw CloudConnectionFailure.storage }
        file = directory.appendingPathComponent(profileID).appendingPathComponent("receipts.json")
        if FileManager.default.fileExists(atPath: file.path) {
            let bytes = try Data(contentsOf: file)
            guard bytes.count <= 4 * 1024 * 1024 else { throw CloudConnectionFailure.storage }
            let loaded = try JSONDecoder().decode(State.self, from: bytes)
            guard loaded.version == 1, loaded.receipts.count <= 2000,
                  Set(loaded.receipts.map(\.commandId)).count == loaded.receipts.count else { throw CloudConnectionFailure.storage }
            state = loaded
        }
    }
    func prepare(_ command: CloudCommandEnvelope) throws -> (receipt: CloudDeviceReceipt, dispatch: Bool) {
        if let existing = state.receipts.first(where: { $0.commandId == command.id }) {
            guard existing.commandDigest == command.digest, existing.deviceId == command.deviceId,
                  existing.generation == command.generation, existing.serverEpoch == command.serverEpoch else { throw CloudConnectionFailure.protocolMismatch }
            return (existing, false)
        }
        guard state.receipts.count < 2000, command.serverEpoch >= state.epoch,
              command.serverEpoch > state.epoch || command.sequence > state.sequence else { throw CloudConnectionFailure.storage }
        let receipt = CloudDeviceReceipt(version: 1, type: "receipt", id: UUID().uuidString, commandId: command.id,
            deviceId: command.deviceId, generation: command.generation, serverEpoch: command.serverEpoch,
            commandDigest: command.digest, status: "unknown", code: "unknown")
        var next = state; next.epoch = command.serverEpoch; next.sequence = command.sequence; next.receipts.append(receipt)
        try commit(next)
        // Unknown is durable before execution. A crash/restart reports uncertainty,
        // never reruns the command to discover whether an effect happened.
        return (receipt, true)
    }
    func finish(_ receipt: CloudDeviceReceipt) throws {
        guard let index = state.receipts.firstIndex(where: { $0.id == receipt.id }),
              try state.receipts[index].resolved(status: receipt.status, code: receipt.code) == receipt,
              state.receipts[index].status == "unknown" || state.receipts[index] == receipt else { throw CloudConnectionFailure.storage }
        var next = state; next.receipts[index] = receipt; try commit(next)
    }
    func receipts(deviceID: String) -> [CloudDeviceReceipt] { state.receipts.filter { $0.deviceId == deviceID } }
    private func commit(_ next: State) throws {
        try RuntimeProfiles.writePrivate(try JSONEncoder().encode(next), to: file)
        state = next
    }
}
