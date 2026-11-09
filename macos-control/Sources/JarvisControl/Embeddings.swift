import Foundation
import NaturalLanguage

struct SentenceEmbeddingQuery {
    static let languages: Set<String> = ["en", "de", "fr", "es", "it", "pt", "nl", "ru", "zh-Hans", "zh-Hant", "ja", "ko"]
    let language: String
    let texts: [String]

    init(_ request: Request) throws {
        guard let language = request.embeddingLanguage, Self.languages.contains(language),
              let texts = request.texts, texts.count <= 16,
              texts.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf8.count <= 16_384 }),
              texts.reduce(0, { $0 + $1.utf8.count }) <= 65_536 else {
            throw ControlFailure("INVALID_EMBEDDING_REQUEST", "Select a supported language and at most 16 nonempty texts, each up to 16384 UTF-8 bytes and 65536 bytes in total. Empty batches only inspect local model availability.")
        }
        self.language = language; self.texts = texts
    }
}

protocol SentenceEmbeddingModel {
    var dimension: Int { get }
    var revision: Int { get }
    func vector(for text: String) -> [Double]?
}
private struct AppleSentenceEmbeddingModel: SentenceEmbeddingModel {
    let embedding: NLEmbedding
    // SDK declarations use NSUInteger; make the internal validated Int bounds
    // explicit instead of depending on imported-property protocol conformance.
    var dimension: Int { Int(exactly: embedding.dimension) ?? -1 }
    var revision: Int { Int(exactly: embedding.revision) ?? -1 }
    func vector(for text: String) -> [Double]? { embedding.vector(for: text) }
}

func normalizedSentenceVector(_ vector: [Double], dimensions: Int) throws -> [Double] {
    guard (1...4096).contains(dimensions), vector.count == dimensions,
          vector.allSatisfy(\.isFinite), let scale = vector.map({ abs($0) }).max(), scale > 0 else {
        throw ControlFailure("INVALID_EMBEDDING_VECTOR", "The local model returned an invalid vector. Lexical retrieval remains available.")
    }
    let scaled = vector.map { $0 / scale }
    let norm = sqrt(scaled.reduce(0) { $0 + $1 * $1 })
    guard norm.isFinite, norm > 0 else {
        throw ControlFailure("INVALID_EMBEDDING_VECTOR", "The local vector could not be normalized. Lexical retrieval remains available.")
    }
    return scaled.map { $0 / norm }
}

/// Uses only an already available Apple model. Never calls requestAssets or any network service.
func sentenceEmbeddings(_ request: Request, deadline: Deadline,
                        loadModel: (NLLanguage) -> (any SentenceEmbeddingModel)? = {
                            guard let embedding = NLEmbedding.sentenceEmbedding(for: $0) else { return nil }
                            return AppleSentenceEmbeddingModel(embedding: embedding)
                        }) throws -> [String: Any] {
    let query = try SentenceEmbeddingQuery(request)
    try deadline.check()
    guard let model = loadModel(NLLanguage(rawValue: query.language)) else {
        return ["kind": "sentence_embeddings", "status": "unavailable", "reason": "model_unavailable",
                "language": query.language, "local": true]
    }
    try deadline.check()
    guard (1...4096).contains(model.dimension), model.revision >= 0,
          query.texts.count * model.dimension <= 16_384 else {
        throw ControlFailure("EMBEDDING_LIMIT", "Local model dimensions or batch output exceed the supported limit. Reduce the batch; lexical retrieval remains available.")
    }
    let os = ProcessInfo.processInfo.operatingSystemVersion
    let osVersion = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
    let identity: [String: Any] = ["id": "apple-nl-sentence.\(query.language)",
        "version": "macos-\(osVersion)-revision-\(model.revision)", "dimensions": model.dimension,
        "language": query.language, "revision": model.revision, "osVersion": osVersion, "local": true]
    var vectors: [[Double]] = []
    for text in query.texts {
        try deadline.check()
        guard let vector = model.vector(for: text) else {
            throw ControlFailure("EMBEDDING_UNAVAILABLE", "The local model could not embed this batch. No partial vectors are returned; lexical retrieval remains available.")
        }
        vectors.append(try normalizedSentenceVector(vector, dimensions: model.dimension))
    }
    try deadline.check()
    return ["kind": "sentence_embeddings", "status": "available", "model": identity, "vectors": vectors]
}
