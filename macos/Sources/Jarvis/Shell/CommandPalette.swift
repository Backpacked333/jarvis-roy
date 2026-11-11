import SwiftUI

/// ⌘K: type to jump to a page or conversation, or to run an action. Arrow keys move, Return runs, Esc closes.
struct CommandPalette: View {
    @ObservedObject var model: AppModel
    @ObservedObject var chrome: WorkspaceChrome
    let assistantAvailable: Bool
    @Environment(\.theme) private var theme
    @Environment(\.openSettings) private var openSettings
    @AppStorage(JarvisTheme.legendsKey) private var legends = false
    @State private var query = ""
    @State private var highlighted = 0
    @FocusState private var focused: Bool

    private struct Item: Identifiable {
        let id: String
        let title: String
        let detail: String
        let icon: String
        var hint: String? = nil
        let run: () -> Void
    }

    private var items: [Item] {
        var all: [Item] = [
            Item(id: "new", title: "New conversation", detail: "Action", icon: "plus", hint: "⌘N") {
                Task { await model.startNewConversation() }
            },
            Item(id: "legends", title: legends ? "Turn off Legends mode" : "Turn on Legends mode",
                 detail: "Appearance", icon: legends ? "crown.fill" : "crown", hint: "⇧⌘L") { legends.toggle() },
            Item(id: "stop", title: "Stop all work", detail: "Action", icon: "stop.fill", hint: "⌘.") {
                Task { await model.stopAll() }
            },
            Item(id: "mute", title: "Mute voice", detail: "Action", icon: "mic.slash") { model.muteVoice() },
            Item(id: "sidebar", title: chrome.sidebarVisible ? "Hide sidebar" : "Show sidebar",
                 detail: "View", icon: "sidebar.leading", hint: "⌃⌘S") { chrome.sidebarVisible.toggle() },
            Item(id: "settings", title: "Open Settings", detail: "Action", icon: "gearshape", hint: "⌘,") { openSettings() }
        ]
        for tab in WorkspaceTab.allCases where tab != .assistant || assistantAvailable {
            all.append(Item(id: "tab:" + tab.rawValue, title: tab.title, detail: "Page · " + tab.summary,
                            icon: tab.icon, hint: "⌘\(tab.shortcutNumber)") { model.tab = tab })
        }
        for conversation in model.conversations.prefix(40) {
            all.append(Item(id: "conversation:" + conversation.id, title: conversation.title, detail: "Conversation",
                            icon: "bubble.left") { model.selectConversation(conversation.id) })
        }
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return all }
        return all.filter { $0.title.lowercased().contains(needle) || $0.detail.lowercased().contains(needle) }
    }

    var body: some View {
        let results = items
        ZStack(alignment: .top) {
            // Modal: dim the world behind the panel.
            Color.black.opacity(theme.isDark ? 0.45 : 0.25)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { close() }
                .accessibilityHidden(true)
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 15)).foregroundStyle(theme.muted)
                    TextField("Jump to a page, conversation or action", text: $query)
                        .textFieldStyle(.plain).font(.system(size: 16)).foregroundStyle(theme.text)
                        .focused($focused)
                        .onSubmit { run(results, at: highlighted) }
                        .onKeyPress(.downArrow) { move(1, count: results.count); return .handled }
                        .onKeyPress(.upArrow) { move(-1, count: results.count); return .handled }
                    KeyHint(keys: "esc")
                }
                .padding(.horizontal, 18).frame(height: 54)
                Rectangle().fill(theme.line).frame(height: 1)
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            if results.isEmpty {
                                Text("Nothing matches “\(query)”.").font(.system(size: 13)).foregroundStyle(theme.muted)
                                    .padding(.vertical, 26)
                            }
                            ForEach(Array(results.enumerated()), id: \.element.id) { index, item in
                                Button { run(results, at: index) } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: item.icon).font(.system(size: 13, weight: .medium))
                                            .foregroundStyle(theme.accentText).frame(width: 22)
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(item.title).font(.system(size: 13, weight: .medium)).foregroundStyle(theme.text).lineLimit(1)
                                            Text(item.detail).font(.system(size: 11)).foregroundStyle(theme.muted).lineLimit(1)
                                        }
                                        Spacer(minLength: 8)
                                        if let hint = item.hint { KeyHint(keys: hint) }
                                    }
                                    .padding(.horizontal, 12).frame(height: 44)
                                }
                                .buttonStyle(JarvisRowButtonStyle(selected: index == highlighted))
                                .id(item.id)
                            }
                        }
                        .padding(8)
                    }
                    .frame(maxHeight: 380)
                    .onChange(of: highlighted) { _, index in
                        if results.indices.contains(index) { proxy.scrollTo(results[index].id) }
                    }
                }
            }
            .frame(width: 580)
            .jarvisGlass(cornerRadius: 22, frosted: true)
            .padding(.top, 90)
            .onExitCommand { close() }
        }
        .onAppear { focused = true }
        .onChange(of: query) { _, _ in highlighted = 0 }
    }

    private func move(_ delta: Int, count: Int) {
        guard count > 0 else { return }
        highlighted = (highlighted + delta + count) % count
    }

    private func run(_ results: [Item], at index: Int) {
        guard results.indices.contains(index) else { return }
        close()
        results[index].run()
    }

    private func close() { chrome.paletteVisible = false }
}
