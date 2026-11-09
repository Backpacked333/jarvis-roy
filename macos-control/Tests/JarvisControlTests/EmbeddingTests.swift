import Foundation
import NaturalLanguage
import XCTest
@testable import JarvisControl

final class EmbeddingTests: XCTestCase {
    private func request(_ fields: [String: Any] = [:]) throws -> Request {
        var body: [String: Any] = ["version": 1, "operation": "sentence_embeddings", "embeddingLanguage": "en", "texts": ["Selected passage"]]
        body.merge(fields) { _, value in value }
        return try JSONDecoder().decode(Request.self, from: JSONSerialization.data(withJSONObject: body))
    }

    func testEmbeddingQueryRequiresSupportedLanguageAndBoundedNonemptyTextWithoutTruncation() throws {
        XCTAssertEqual(try SentenceEmbeddingQuery(request()).texts, ["Selected passage"])
        XCTAssertTrue(try SentenceEmbeddingQuery(request(["texts": [String]()])).texts.isEmpty)
        for fields: [String: Any] in [
            ["embeddingLanguage": "arbitrary-model"], ["texts": [""]], ["texts": ["  \n"]],
            ["texts": [String(repeating: "🙂", count: 4097)]],
            ["texts": [String](repeating: "passage", count: 17)],
            ["texts": [String](repeating: String(repeating: "a", count: 16_384), count: 5)],
        ] {
            XCTAssertThrowsError(try SentenceEmbeddingQuery(request(fields)))
        }
    }

    func testMissingLocalModelReturnsExplicitLexicalFallbackWithoutVectorCall() throws {
        let result = try sentenceEmbeddings(request(), deadline: Deadline(), loadModel: { language in
            XCTAssertEqual(language, .english)
            return nil
        })
        XCTAssertEqual(result["status"] as? String, "unavailable")
        XCTAssertEqual(result["reason"] as? String, "model_unavailable")
        XCTAssertEqual(result["local"] as? Bool, true)
        XCTAssertNil(result["vectors"])
    }

    func testDiscoveryAndVectorsBindLanguageRevisionDimensionsAndOSWithoutReturningText() throws {
        let model = FixtureEmbeddingModel()
        let discovered = try sentenceEmbeddings(request(["texts": [String]()]), deadline: Deadline(), loadModel: { _ in model })
        XCTAssertEqual(model.calls, 0)
        let identity = try XCTUnwrap(discovered["model"] as? [String: Any])
        XCTAssertEqual(identity["id"] as? String, "apple-nl-sentence.en")
        XCTAssertEqual(identity["dimensions"] as? Int, 2)
        XCTAssertEqual(identity["revision"] as? Int, 4)
        XCTAssertTrue((identity["version"] as? String)?.hasSuffix("-revision-4") == true)
        let result = try sentenceEmbeddings(request(), deadline: Deadline(), loadModel: { _ in model })
        let vectors = try XCTUnwrap(result["vectors"] as? [[Double]])
        XCTAssertEqual(vectors.count, 1)
        XCTAssertEqual(vectors[0][0], 0.6, accuracy: 1e-12)
        XCTAssertEqual(vectors[0][1], 0.8, accuracy: 1e-12)
        let json = String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
        XCTAssertFalse(json.contains("Selected passage"))
    }

    func testInvalidMissingAndOversizedVectorsFailWithoutPartialSuccess() throws {
        for vector in [[0.0, 0], [Double.nan, 1], [Double.infinity, 1], [1]] {
            XCTAssertThrowsError(try normalizedSentenceVector(vector, dimensions: 2))
        }
        let large = try normalizedSentenceVector([Double.greatestFiniteMagnitude, Double.greatestFiniteMagnitude], dimensions: 2)
        XCTAssertEqual(large[0], sqrt(0.5), accuracy: 1e-12)
        let missing = FixtureEmbeddingModel(); missing.output = nil
        XCTAssertThrowsError(try sentenceEmbeddings(request(), deadline: Deadline(), loadModel: { _ in missing }))
        let oversized = FixtureEmbeddingModel(); oversized.dimension = 4096
        XCTAssertThrowsError(try sentenceEmbeddings(request(["texts": [String](repeating: "passage", count: 5)]), deadline: Deadline(), loadModel: { _ in oversized }))
        XCTAssertEqual(oversized.calls, 0)
    }
}

private final class FixtureEmbeddingModel: SentenceEmbeddingModel {
    var dimension = 2
    var revision = 4
    var calls = 0
    var output: [Double]? = [3, 4]
    func vector(for text: String) -> [Double]? { calls += 1; return output }
}
