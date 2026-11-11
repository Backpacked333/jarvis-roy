import SwiftUI

/// The floating navigation panel: pages, conversations and the Legends mode switch.
/// It is one frosted glass body; every row inside it is flat.
struct SidebarView: View {
    @ObservedObject var model: AppModel
    @ObservedObject var rooms: RoomsModel
    let assistantAvailable: Bool
    @Environment(\.theme) private var theme
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var primaryTabs: [WorkspaceTab] {
        [.today, .assistant, .workspace, .rooms].filter { $0 != .assistant || assistantAvailable }
    }
    private let secondaryTabs: [WorkspaceTab] = [.memory, .capabilities, .privacy]

    private var filteredConversations: [Conversation] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !needle.isEmpty else { return model.conversations }
        return model.conversations.filter { conversation in
            conversation.title.lowercased().contains(needle)
                || conversation.messages.contains { $0.text.lowercased().contains(needle) }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brand.padding(.top, 40).padding(.horizontal, 8)
            Button { Task { await model.startNewConversation() } } label: {
                HStack(spacing: 8) {
                    Image(systemName: "plus")
                    Text("New conversation")
                    Spacer(minLength: 4)
                    Text("⌘N").font(.system(size: 11, weight: .medium)).opacity(0.7)
                }.frame(maxWidth: .infinity)
            }
            .buttonStyle(.jarvisPrimary)
            .disabled(!model.isConnected || model.pendingActions.contains("new-conversation"))
            .padding(.top, 16).padding(.horizontal, 4)

            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(primaryTabs) { tabRow($0) }
                    sectionLabel("More")
                    ForEach(secondaryTabs) { tabRow($0) }
                    sectionLabel("Conversations")
                    searchField.padding(.bottom, 4)
                    conversationList
                }
                .padding(.top, 12).padding(.bottom, 8)
            }
            .scrollIndicators(.never)

            footer
        }
        .padding(.horizontal, 8)
        .jarvisGlass(cornerRadius: 22, frosted: true)
    }

    private var brand: some View {
        HStack(spacing: 10) {
            JarvisOrb(size: 26, listening: model.voice.isListening, working: model.activeCount > 0, connected: model.isConnected)
                .frame(width: 30, height: 30)
            Text("Jarvis").font(.system(size: 17, weight: .semibold)).foregroundStyle(theme.text)
            if theme.isLegends {
                Text("Legends")
                    .font(.system(size: 10, weight: .bold)).tracking(0.6)
                    .foregroundStyle(theme.onAccent)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(theme.accentFill, in: Capsule())
                    .transition(.scale.combined(with: .opacity))
            }
            Spacer(minLength: 0)
        }
    }

    private func sectionLabel(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(theme.faint)
            .padding(.horizontal, 10).padding(.top, 16).padding(.bottom, 4)
    }

    private func tabRow(_ tab: WorkspaceTab) -> some View {
        let selected = model.tab == tab
        return Button { model.tab = tab } label: {
            HStack(spacing: 10) {
                Image(systemName: tab.icon).font(.system(size: 13, weight: .medium))
                    .foregroundStyle(theme.accentText).frame(width: 20)
                Text(tab.title).font(.system(size: 13, weight: selected ? .semibold : .regular)).foregroundStyle(theme.text)
                Spacer(minLength: 4)
                if badge(tab) > 0 { CountBadge(count: badge(tab)) }
            }
            .padding(.horizontal, 10).frame(height: 34)
        }
        .buttonStyle(JarvisRowButtonStyle(selected: selected))
        .help("\(tab.summary) (⌘\(tab.shortcutNumber))")
        .accessibilityLabel(badge(tab) > 0 ? "\(tab.title), \(badge(tab)) need attention" : tab.title)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private func badge(_ tab: WorkspaceTab) -> Int {
        switch tab {
        case .workspace: return model.approvalCount
        case .rooms: return rooms.questions.count + rooms.approvals.count
        default: return 0
        }
    }

    private var searchField: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundStyle(theme.faint)
            TextField("Search conversations", text: $query)
                .textFieldStyle(.plain).font(.system(size: 12)).focused($searchFocused)
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(theme.faint).accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 10).frame(height: 30)
        .background(theme.trough, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
            .strokeBorder(searchFocused ? theme.accent : Color.clear, lineWidth: 2))
        .padding(.horizontal, 2)
    }

    @ViewBuilder private var conversationList: some View {
        let conversations = filteredConversations
        if conversations.isEmpty {
            Text(query.isEmpty ? "Your conversations will appear here." : "No conversations match “\(query)”.")
                .font(.system(size: 12)).foregroundStyle(theme.faint)
                .padding(.horizontal, 10).padding(.vertical, 8)
        }
        ForEach(conversations) { conversation in conversationRow(conversation) }
    }

    private func conversationRow(_ conversation: Conversation) -> some View {
        let selected = model.tab == .workspace && model.selectedConversationID == conversation.id
        let pending = model.tasks.filter { $0.conversationId == conversation.id && $0.canCancel }
        let needsApproval = pending.contains { !$0.approvals.isEmpty || !($0.questions ?? []).isEmpty }
        return Button { model.selectConversation(conversation.id) } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(conversation.title).font(.system(size: 13, weight: selected ? .semibold : .regular))
                    .foregroundStyle(theme.text).lineLimit(1)
                HStack(spacing: 6) {
                    if needsApproval {
                        Label("Needs you", systemImage: "hand.raised.fill").foregroundStyle(theme.warning)
                    } else if !pending.isEmpty {
                        Label("Working", systemImage: "circle.dotted").foregroundStyle(theme.accentText)
                    }
                    if let when = JarvisFormat.relative(conversation.updatedAt) {
                        Text(when).foregroundStyle(theme.faint)
                    }
                }
                .font(.system(size: 11)).labelStyle(.titleAndIcon).lineLimit(1)
            }
            .padding(.horizontal, 10).padding(.vertical, 7)
        }
        .buttonStyle(JarvisRowButtonStyle(selected: selected))
        .accessibilityLabel("\(conversation.title)\(needsApproval ? ", needs your review" : pending.isEmpty ? "" : ", working")")
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            Rectangle().fill(theme.line).frame(height: 1)
            LegendsModeToggle().padding(.horizontal, 10)
            HStack(spacing: 8) {
                Circle().fill(model.isConnected ? theme.success : theme.warning).frame(width: 7, height: 7)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.isConnected ? "Agent connected" : "Agent offline")
                        .font(.system(size: 11, weight: .medium)).foregroundStyle(theme.muted)
                    Text(model.modelName).font(.system(size: 10)).foregroundStyle(theme.faint).lineLimit(1)
                }
                Spacer(minLength: 4)
                SettingsLink { Image(systemName: "gearshape") }
                    .buttonStyle(.jarvisIcon)
                    .help("Settings (⌘,)")
                    .accessibilityLabel("Settings")
            }
            .padding(.horizontal, 10)
        }
        .padding(.bottom, 12)
    }
}
