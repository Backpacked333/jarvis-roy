import Foundation
import CryptoKit
import XCTest
@testable import Jarvis

@MainActor
final class RoomsClientTests: XCTestCase {
    private let token = String(repeating: "fixture_local_token_", count: 3)

    func testStateDecodingUsesAuthenticatedLoopbackWithoutOriginOrQueryCredentials() async throws {
        let fixture = try RoomsFixture.load()
        let transport = RoomsTestTransport { request, limit in
            XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:39202/v1/harness/state")
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.value(forHTTPHeaderField: "Origin"))
            XCTAssertEqual(limit, 8 * 1_024 * 1_024)
            return RoomsTestTransport.response(request, data: try JSONEncoder().encode(fixture.state))
        }
        let client = HarnessClient(token: token, transport: transport)
        let state = try await client.state()
        XCTAssertEqual(state, fixture.state)
        XCTAssertEqual(transport.requests[0].value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
    }

    func testNoTokenNeverContactsService() async {
        let transport = RoomsTestTransport { request, _ in XCTFail("Must fail before transport"); return RoomsTestTransport.response(request, data: Data()) }
        do { _ = try await HarnessClient(token: "", transport: transport).state(); XCTFail("Expected configuration error") }
        catch { XCTAssertEqual(error as? RoomsError, .configuration) }
        XCTAssertTrue(transport.requests.isEmpty)
    }

    func testRejectsUnsupportedStateAndNestedVersions() async throws {
        var fixture = try RoomsFixture.load()
        fixture.state.version = 2
        let transport = RoomsTestTransport { request, _ in RoomsTestTransport.response(request, data: try JSONEncoder().encode(fixture.state)) }
        let client = HarnessClient(token: token, transport: transport)
        do { _ = try await client.state(); XCTFail("Expected version rejection") }
        catch { XCTAssertEqual(error as? RoomsError, .unsupportedVersion) }
        fixture.state.version = 1; fixture.state.artifacts[0].version = 99
        do { _ = try await client.state(); XCTFail("Expected nested version rejection") }
        catch { XCTAssertEqual(error as? RoomsError, .unsupportedVersion) }
    }

    func testQuestionBodyRetainsNullAndCompleteBinding() async throws {
        let question = try RoomsFixture.load().state.questions[0]
        let transport = RoomsTestTransport { request, _ in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/v1/harness/questions/\(question.id)/answer")
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
            XCTAssertTrue(body["text"] is NSNull)
            XCTAssertEqual(body["source"] as? String, "text")
            XCTAssertEqual(body["choiceId"] as? String, "dark")
            let decoded = try JSONDecoder().decode(HarnessAnswerRequest.self, from: XCTUnwrap(request.httpBody))
            XCTAssertEqual(decoded.binding, question.binding)
            return RoomsTestTransport.response(request, data: try JSONEncoder().encode(question))
        }
        _ = try await HarnessClient(token: token, transport: transport).answerQuestion(.init(binding: question.binding, source: "text", text: nil, choiceId: "dark"))
    }

    func testEventsCarryBoundedCursorAndPreserveResetFlag() async throws {
        var events = try RoomsFixture.load().events
        events.resetRequired = true
        let transport = RoomsTestTransport { request, _ in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query?.first(where: { $0.name == "after" })?.value, "17")
            XCTAssertEqual(query?.first(where: { $0.name == "roomId" })?.value, "room_fixture")
            return RoomsTestTransport.response(request, data: try JSONEncoder().encode(events))
        }
        let value = try await HarnessClient(token: token, transport: transport).events(after: 17, roomId: "room_fixture")
        XCTAssertTrue(value.resetRequired)
    }

    func testTooManyEventsAndWrongEndpointResponsesAreRejected() async throws {
        var events = try RoomsFixture.load().events
        events.events = Array(repeating: events.events[0], count: 1_001)
        let transport = RoomsTestTransport { request, _ in RoomsTestTransport.response(request, data: try JSONEncoder().encode(events)) }
        let client = HarnessClient(token: token, transport: transport)
        do { _ = try await client.events(after: 0, roomId: nil); XCTFail("Expected bound rejection") } catch { }
        transport.handler = { _, _ in (Data(), HTTPURLResponse(url: URL(string: "https://example.invalid")!, statusCode: 200, httpVersion: nil, headerFields: nil)!) }
        do { _ = try await client.state(); XCTFail("Expected endpoint rejection") } catch { XCTAssertEqual(error as? RoomsError, .invalidResponse) }
    }

    func testConflictsAreSpecificAndDoNotLeakToken() async throws {
        let token = token
        let transport = RoomsTestTransport { request, _ in
            RoomsTestTransport.response(request, data: try JSONEncoder().encode(["error": "stale \(token)"]), status: 409)
        }
        do { _ = try await HarnessClient(token: token, transport: transport).state(); XCTFail("Expected conflict") }
        catch {
            guard case .conflict(let message) = error as? RoomsError else { return XCTFail("Expected typed conflict") }
            XCTAssertFalse(message.contains(token))
            XCTAssertTrue(message.contains("[redacted]"))
        }
    }

    func testArtifactRequestEncodesPathAndChecksHashBeforeReturningSource() async throws {
        var artifact = try RoomsFixture.load().state.artifacts[0]
        let source = Data("<script>untrusted()</script>".utf8)
        let path = "folder/résumé #1.html"
        artifact.files = [.init(path: path, sha256: SHA256.hash(data: source).map { String(format: "%02x", $0) }.joined(), bytes: source.count, mediaType: "text/html")]
        let transport = RoomsTestTransport { request, limit in
            XCTAssertEqual(request.url?.path, "/v1/harness/rooms/\(artifact.roomId)/runs/\(artifact.runId)/artifacts/\(artifact.id)/content")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            XCTAssertEqual(query?.first(where: { $0.name == "path" })?.value, path)
            XCTAssertEqual(query?.first(where: { $0.name == "digest" })?.value, artifact.digest)
            XCTAssertNil(request.url?.fragment)
            XCTAssertLessThanOrEqual(limit, 8_192)
            return RoomsTestTransport.response(request, data: source)
        }
        let bytes = try await HarnessClient(token: token, transport: transport).artifactContent(artifact, path: path)
        XCTAssertEqual(bytes, source)
    }

    func testTamperedArtifactAndTraversalAreRejected() async throws {
        let artifact = try RoomsFixture.load().state.artifacts[0]
        let transport = RoomsTestTransport { request, _ in RoomsTestTransport.response(request, data: Data("tampered".utf8)) }
        let client = HarnessClient(token: token, transport: transport)
        do { _ = try await client.artifactContent(artifact, path: artifact.files[0].path); XCTFail("Expected digest rejection") }
        catch { XCTAssertEqual(error as? RoomsError, .integrity) }
        do { _ = try await client.artifactContent(artifact, path: "../secrets"); XCTFail("Expected path rejection") }
        catch { XCTAssertEqual(error as? RoomsError, .invalidPath) }
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testIdentifierInjectionAndArbitraryRunActionNeverReachTransport() async throws {
        let transport = RoomsTestTransport { request, _ in XCTFail("Must reject before transport"); return RoomsTestTransport.response(request, data: Data()) }
        let client = HarnessClient(token: token, transport: transport)
        do { _ = try await client.events(after: 0, roomId: "room/../../state"); XCTFail("Expected path rejection") } catch { }
        do { _ = try await client.controlRun("room", runId: "run", action: "approve", revision: 1); XCTFail("No approval action") } catch { }
        XCTAssertTrue(transport.requests.isEmpty)
    }
}
