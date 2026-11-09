import SwiftUI

struct VoicePauseSettingsView: View {
    let mode: VoiceCaptureMode
    @AppStorage("Jarvis.conversationPauseSeconds") private var conversational = 1.2
    @AppStorage("Jarvis.dictationPauseSeconds") private var dictation = 4.0
    @State private var visible = false
    var body: some View {
        Button { visible.toggle() } label: { Image(systemName: "slider.horizontal.3") }.help("Adjust voice pauses")
            .popover(isPresented: $visible) {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Make room for your pauses").font(.headline)
                    Text("Conversation: \(VoicePausePolicy.clamped(conversational, mode: .conversation), specifier: "%.1f") seconds")
                    Slider(value: $conversational, in: 0.6...4, step: 0.2)
                    Text("Dictation: \(VoicePausePolicy.clamped(dictation, mode: .dictation), specifier: "%.0f") seconds")
                    Slider(value: $dictation, in: 3...15, step: 1)
                    Text("Dictation keeps completed segments together for up to 8 minutes or 16,000 characters. A long pause turns the microphone off; Continue resumes in the original context, and Finish submits the complete turn. Stop discards it.")
                        .font(.caption).foregroundStyle(.secondary)
                    Button("Done") { visible = false }
                }.padding(20).frame(width: 340)
            }
    }
}
