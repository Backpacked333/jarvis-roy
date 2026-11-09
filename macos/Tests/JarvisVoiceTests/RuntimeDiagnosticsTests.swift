import Foundation
import XCTest
@testable import Jarvis

final class RuntimeDiagnosticsTests: XCTestCase {
    func testMonotonicDurationsRejectClockChangesAndNonfiniteOrOversizedSamples() throws {
        XCTAssertEqual(try XCTUnwrap(RuntimeDiagnosticPolicy.elapsedMilliseconds(from: 100, to: 100.125)), 125, accuracy: 0.0001)
        XCTAssertEqual(RuntimeDiagnosticPolicy.elapsedMilliseconds(from: 100, to: 100), 0)
        XCTAssertNil(RuntimeDiagnosticPolicy.elapsedMilliseconds(from: 100, to: 99))
        XCTAssertNil(RuntimeDiagnosticPolicy.elapsedMilliseconds(from: -1, to: 1))
        XCTAssertNil(RuntimeDiagnosticPolicy.elapsedMilliseconds(from: .nan, to: 1))
        XCTAssertNil(RuntimeDiagnosticPolicy.elapsedMilliseconds(from: 1, to: .infinity))
        XCTAssertNil(RuntimeDiagnosticPolicy.elapsedMilliseconds(from: 1, to: 602))
    }

    func testSpeechMilestonesRejectStaleGenerationsAndOnlyRecordEachStageOnce() throws {
        var trace = RuntimeLatencySpan(generation: 8, startedAt: 100)
        XCTAssertNil(trace.finish(.firstPCM, generation: 7, at: 100.5))
        XCTAssertNil(trace.finish(.firstPCM, generation: 8, at: 99))
        XCTAssertEqual(try XCTUnwrap(trace.finish(.firstPCM, generation: 8, at: 100.25)), 250, accuracy: 0.0001)
        XCTAssertNil(trace.finish(.firstPCM, generation: 8, at: 101))
        XCTAssertEqual(try XCTUnwrap(trace.finish(.firstOutputRendered, generation: 8, at: 100.75)), 750, accuracy: 0.0001)
        let replacement = RuntimeLatencySpan(generation: 9, startedAt: 101)
        trace = replacement
        XCTAssertNil(trace.finish(.firstOutputRendered, generation: 8, at: 102))
        XCTAssertEqual(try XCTUnwrap(trace.finish(.firstOutputRendered, generation: 9, at: 101.5)), 500, accuracy: 0.0001)
    }

    func testRenderTimestampIgnoresSilenceAndPreservesFirstNonSilentCallback() {
        let meter = VoiceOutputMeter()
        [Float](repeating: 0, count: 16).withUnsafeBufferPointer { meter.observe($0, stride: 1, at: 10) }
        XCTAssertNil(meter.firstActiveRenderTime)
        [Float](repeating: 0.1, count: 16).withUnsafeBufferPointer { meter.observe($0, stride: 1, at: 10.25) }
        [Float](repeating: 0.2, count: 16).withUnsafeBufferPointer { meter.observe($0, stride: 1, at: 10.5) }
        XCTAssertEqual(meter.firstActiveRenderTime, 10.25)
    }

    @MainActor
    func testDiagnosticSinkRejectsPrivateLabelsAndInvalidMetricsAndRetainsBoundedHistory() {
        let diagnostics = RuntimeDiagnostics()
        XCTAssertFalse(diagnostics.record("private utterance must never be logged", role: "voice"))
        XCTAssertFalse(diagnostics.record("voice_first_pcm", role: "private-account-id"))
        for invalid in [Double.nan, Double.infinity, -1, RuntimeDiagnosticPolicy.maximumDurationMilliseconds + 1] {
            XCTAssertFalse(diagnostics.record("voice_first_pcm", role: "voice", durationMilliseconds: invalid))
        }
        XCTAssertTrue(diagnostics.entries.isEmpty)
        for index in 0..<110 {
            XCTAssertTrue(diagnostics.record("voice_first_pcm", role: "voice", durationMilliseconds: Double(index)))
        }
        XCTAssertEqual(diagnostics.entries.count, 100)
        XCTAssertEqual(diagnostics.entries.first?.durationMilliseconds, 10)
        XCTAssertEqual(diagnostics.entries.last?.durationMilliseconds, 109)
    }
}
