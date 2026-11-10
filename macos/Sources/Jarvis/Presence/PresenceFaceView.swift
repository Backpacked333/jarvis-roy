import SwiftUI
import WebKit

/// Everything the particle face is told. It is derived only from the real voice state and the measured audio
/// levels; the face has no microphone, socket or network access of its own and cannot start anything.
struct PresenceState: Equatable {
    var mode: CoreView.Mode
    var inputRMS: Double = 0
    var playbackRMS: Double = 0
    /// True when motion should stop: Reduce Motion is on, or the window is not active.
    var still = false

    /// The face's own vocabulary is smaller than the core's; anything that is not live voice reads as idle.
    var faceMode: String {
        switch mode {
        case .connecting: return "connecting"
        case .listening: return "listening"
        case .thinking: return "thinking"
        case .speaking: return "speaking"
        case .standby, .armed, .stopped, .unavailable, .authorization: return "idle"
        }
    }

    /// Particle colour follows the core's tint: cyan normally, amber while a decision is on screen, grey when stopped.
    var tint: [Double] {
        switch mode {
        case .authorization: return [1.0, 0.76, 0.43]
        case .stopped, .unavailable: return [0.50, 0.60, 0.65]
        case .armed: return [1.0, 1.0, 1.0]
        default: return [0.90, 0.99, 0.99]
        }
    }

    var brightness: Double {
        switch mode {
        case .listening, .speaking: return 1.9
        case .stopped, .unavailable: return 0.9
        default: return 1.6
        }
    }

    private static func level(_ value: Double) -> Double { value.isFinite ? min(1, max(0, value)) : 0 }

    /// The one call made into the page. Only numbers and fixed words are interpolated, never free text.
    var script: String {
        let frozen = still || mode == .stopped || mode == .unavailable
        return String(format: "window.jarvisPresence&&window.jarvisPresence.set({mode:'%@',input:%.3f,output:%.3f,still:%@,tint:[%.3f,%.3f,%.3f],brightness:%.2f});",
                      faceMode, Self.level(inputRMS), Self.level(playbackRMS), frozen ? "true" : "false",
                      tint[0], tint[1], tint[2], brightness)
    }
}

/// The page that hosts the face. Its content security policy forbids every network request, and scripts run only
/// with a per-launch nonce, so nothing but the two bundled scripts can execute.
enum PresenceDocument {
    static let html: String? = make()

    static var resources: Bundle {
        Bundle.main.url(forResource: "JarvisRoy_Jarvis", withExtension: "bundle").flatMap(Bundle.init(url:)) ?? Bundle.module
    }

    private static func make() -> String? {
        guard let dataURL = resources.url(forResource: "presence-data", withExtension: "js"),
              let engineURL = resources.url(forResource: "presence-engine", withExtension: "js"),
              let data = try? String(contentsOf: dataURL, encoding: .utf8),
              let engine = try? String(contentsOf: engineURL, encoding: .utf8) else { return nil }
        return document(data: data, engine: engine, nonce: UUID().uuidString.replacingOccurrences(of: "-", with: ""))
    }

    static func document(data: String, engine: String, nonce: String) -> String? {
        // A script that could close its own tag would let later text run as markup.
        guard !data.lowercased().contains("</script"), !engine.lowercased().contains("</script"),
              nonce.allSatisfy({ $0.isLetter || $0.isNumber }), !nonce.isEmpty else { return nil }
        let policy = "default-src 'none'; script-src 'nonce-\(nonce)'; style-src 'nonce-\(nonce)'"
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(policy)">
        <style nonce="\(nonce)">html,body{margin:0;height:100%;background:transparent;overflow:hidden}canvas{width:100%;height:100%;display:block}</style>
        </head><body><canvas id="face"></canvas>
        <script nonce="\(nonce)">\(data)</script>
        <script nonce="\(nonce)">\(engine)</script>
        </body></html>
        """
    }
}

/// The particle face, drawn by WebGL in a web view with a transparent background. It reports `ready` once the
/// face is actually on screen, so the core can keep its drawn sphere until then, and for good if WebGL is unavailable.
struct PresenceFaceView: NSViewRepresentable {
    var state: PresenceState
    @Binding var ready: Bool

    func makeCoordinator() -> Coordinator { Coordinator(ready: $ready) }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(context.coordinator, name: "presence")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.setValue(false, forKey: "drawsBackground")
        view.allowsMagnification = false
        view.allowsBackForwardNavigationGestures = false
        if let html = PresenceDocument.html { view.loadHTMLString(html, baseURL: nil) }
        return view
    }

    func updateNSView(_ view: WKWebView, context: Context) {
        context.coordinator.push(state, to: view)
    }

    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        // The content controller holds its handler strongly; removing it lets the view and coordinator go.
        view.configuration.userContentController.removeScriptMessageHandler(forName: "presence")
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private var ready: Binding<Bool>
        private var faceLoaded = false
        private var last: PresenceState?
        private var lastPush = Date.distantPast

        init(ready: Binding<Bool>) { self.ready = ready }

        func push(_ state: PresenceState, to view: WKWebView, force: Bool = false) {
            guard faceLoaded else { last = state; return }
            let now = Date()
            // Audio levels arrive many times a second. A change of mode always goes through; levels are sampled.
            let modeChanged = last?.mode != state.mode || last?.still != state.still
            guard force || modeChanged || (state != last && now.timeIntervalSince(lastPush) >= 0.05) else { return }
            last = state
            lastPush = now
            view.evaluateJavaScript(state.script, completionHandler: nil)
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "presence", let body = message.body as? [String: Any], let event = body["event"] as? String else { return }
            switch event {
            case "ready":
                faceLoaded = true
                if let last, let view = message.webView { push(last, to: view, force: true) }
                ready.wrappedValue = true
            case "failed", "lost":
                faceLoaded = false
                ready.wrappedValue = false
            default:
                break
            }
        }

        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            // Only the initial in-memory document may load. The face never navigates anywhere.
            decisionHandler(navigationAction.navigationType == .other && navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            faceLoaded = false
            ready.wrappedValue = false
        }
    }
}
