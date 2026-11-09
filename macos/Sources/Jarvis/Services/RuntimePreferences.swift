import Foundation

struct RuntimePreferences {
    let defaults: UserDefaults
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    static let flags = [
        "JARVIS_ENABLE_ASSISTANT": "Jarvis.assistantEnabled",
        "JARVIS_ENABLE_KNOWLEDGE": "Jarvis.knowledgeEnabled",
        "JARVIS_ENABLE_MEMORY": "Jarvis.memoryEnabled",
        "JARVIS_ENABLE_SEMANTIC_RETRIEVAL": "Jarvis.semanticRetrievalEnabled",
        "JARVIS_ENABLE_RESEARCH": "Jarvis.researchEnabled",
        "JARVIS_ENABLE_VOICE_APPROVAL": "Jarvis.voiceApprovalEnabled",
        "JARVIS_ENABLE_DESKTOP": "Jarvis.desktopEnabled",
        "JARVIS_ENABLE_TERMINAL": "Jarvis.terminalEnabled",
        "JARVIS_ENABLE_APPLE_SERVICES": "Jarvis.appleServicesEnabled",
        "JARVIS_ENABLE_OBJECTIVES": "Jarvis.objectivesEnabled",
        "JARVIS_ENABLE_CLOUD": "Jarvis.cloudEnabled",
        "JARVIS_ENABLE_TELEGRAM": "Jarvis.telegramEnabled",
        "JARVIS_ENABLE_GOOGLE": "Jarvis.googleEnabled",
        "JARVIS_ENABLE_PHONE": "Jarvis.phoneEnabled",
    ]

    func environment(inherited: [String: String]) -> [String: String] {
        var result = inherited
        for (name, preference) in Self.flags where inherited[name] == nil {
            result[name] = defaults.bool(forKey: preference) ? "1" : "0"
        }
        for (name, preference) in ["JARVIS_MODEL": "Jarvis.model", "JARVIS_DEEP_MODEL": "Jarvis.deepModel",
                                    "ELEVENLABS_VOICE_ID": "Jarvis.voiceID", "HOME_ASSISTANT_URL": "Jarvis.homeURL"] {
            if inherited[name] == nil, let value = defaults.string(forKey: preference)?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                result[name] = value
            }
        }
        if inherited["JARVIS_WORKER_IMAGE"] == nil,
           let image = Self.validatedWorkerImage(defaults.string(forKey: "Jarvis.workerImage") ?? "") {
            result["JARVIS_WORKER_IMAGE"] = image
        }
        return result
    }

    /// Matches the bridge ImageRefSchema. A mutable image tag never grants a worker environment.
    static func validatedWorkerImage(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.utf16.count <= 256,
              let match = value.range(of: #"^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$"#, options: .regularExpression),
              match == value.startIndex..<value.endIndex else { return nil }
        return value
    }

    /// Provider keys and native control authority are deliberately not shared with every child.
    static func childEnvironment(role: String, source: [String: String], localToken: String,
                                 nativeToken: String, dataDirectory: String, helper: String?) -> [String: String] {
        var result = ["PATH": "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
                      "JARVIS_LOCAL_TOKEN": localToken, "JARVIS_DATA_DIR": dataDirectory]
        var names = ["HOME", "TMPDIR", "USER", "LOGNAME", "JARVIS_MODEL", "JARVIS_DEEP_MODEL", "AI_GATEWAY_API_KEY",
                     "TAVILY_API_KEY", "HOME_ASSISTANT_URL", "HOME_ASSISTANT_TOKEN", "JARVIS_ALLOW_HOME_ASSISTANT_HTTP",
                     "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
                     "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"] + Array(flags.keys)
        if role == "bridge" {
            names += ["ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID", "JARVIS_WORKER_PYTHON", "JARVIS_WORKER_IMAGE", "JARVIS_DOCKER_BINARY"]
            result["JARVIS_NATIVE_TOKEN"] = nativeToken
        } else {
            result["HOST"] = "127.0.0.1"
            result["PORT"] = "39201"
        }
        for name in names { if let value = source[name] { result[name] = value } }
        if let helper { result["JARVIS_NATIVE_HELPER"] = helper }
        return result
    }
}
