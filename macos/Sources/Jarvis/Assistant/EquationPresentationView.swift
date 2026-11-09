import SwiftUI
import WebKit

enum EquationDocument {
    static func make(latex: String, script: String, nonce: String) throws -> String {
        guard latex.utf16.count <= 32_000, nonce.range(of: #"^[A-Za-z0-9]{1,100}$"#, options: .regularExpression) != nil else { throw AssistantClientError.invalidResponse }
        let encoded = try JSONSerialization.data(withJSONObject: [latex], options: [.withoutEscapingSlashes])
        guard var expression = String(data: encoded, encoding: .utf8) else { throw AssistantClientError.invalidResponse }
        // A quoted JS argument is never allowed to terminate its script element.
        expression = expression.replacingOccurrences(of: "<", with: "\\u003c").replacingOccurrences(of: ">", with: "\\u003e")
        return """
        <!doctype html><html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-\(nonce)'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'">
        <style>:root{color-scheme:light dark}body{margin:12px;background:transparent;font-size:24px;overflow:auto}math{font-family:STIX Two Math,Latin Modern Math,serif}.katex-error{font:14px monospace;white-space:pre-wrap}</style></head>
        <body><div id="equation" role="math"></div><script nonce="\(nonce)">\(script)</script>
        <script nonce="\(nonce)">katex.render(\(expression)[0],document.getElementById('equation'),{displayMode:true,output:'mathml',throwOnError:false,trust:false,strict:'error',maxExpand:500,maxSize:20});</script></body></html>
        """
    }
}

struct EquationPresentationView: View {
    let latex: String
    @State private var height: CGFloat = 100
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            EquationWebView(latex: latex, height: $height).frame(height: height)
                .accessibilityLabel("Rendered equation. Original mathematical notation is available below.")
            DisclosureGroup("Original mathematical notation") {
                Text(latex).font(.system(.body, design: .monospaced)).textSelection(.enabled)
            }
        }
    }
}

private struct EquationWebView: NSViewRepresentable {
    let latex: String
    @Binding var height: CGFloat
    func makeCoordinator() -> Coordinator { Coordinator(height: $height) }
    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        return webView
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        guard context.coordinator.latex != latex else { return }
        context.coordinator.latex = latex
        let resources = Bundle.main.url(forResource: "JarvisRoy_Jarvis", withExtension: "bundle").flatMap(Bundle.init(url:)) ?? Bundle.module
        guard let url = resources.url(forResource: "katex.min", withExtension: "js"),
              let script = try? String(contentsOf: url, encoding: .utf8),
              let html = try? EquationDocument.make(latex: latex, script: script, nonce: UUID().uuidString.replacingOccurrences(of: "-", with: "")) else {
            view.loadHTMLString("<p>Equation renderer unavailable. Expand the original notation below.</p>", baseURL: nil); return
        }
        view.loadHTMLString(html, baseURL: nil)
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        var latex: String?
        var height: Binding<CGFloat>
        init(height: Binding<CGFloat>) { self.height = height }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            decisionHandler(navigationAction.navigationType == .other && navigationAction.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            webView.evaluateJavaScript("document.documentElement.scrollHeight") { [weak self] result, _ in
                guard let value = result as? Double, value.isFinite else { return }
                self?.height.wrappedValue = CGFloat(min(480, max(80, value)))
            }
        }
    }
}
