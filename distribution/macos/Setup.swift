import SwiftUI
import AppKit

struct Profile: Decodable, Identifiable {
    let name: String
    let active: Bool
    let inconsistent: Bool
    var id: String { name }
    var label: String { name == "default" ? setupText("Default profile (default)") : name }
    var status: String { active ? setupText("PLUR1BUS activated") : inconsistent ? setupText("Activation incomplete") : setupText("Not activated yet") }
}

struct Inventory: Decodable { let profiles: [Profile] }
struct InstallPlan: Decodable {
    let version: String
    let profiles: [String]
    let confirmation: String
    let activate: Bool
    let effects: String
    let warnings: [String]
}

typealias SetupRunner = (_ python: String, _ arguments: [String], _ progress: ((InstallProgress) -> Void)?, _ completion: @escaping (Int32, String, String) -> Void) -> Void

final class SetupModel: ObservableObject {
    @Published var home = ProcessInfo.processInfo.environment["HERMES_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hermes").path
    @Published var python = ""
    private var automaticPython = ""
    @Published var profiles: [Profile] = []
    @Published var selected: Set<String> = []
    @Published var activate = true
    @Published var consent = false
    @Published var outcome: InstallProgress?
    private var phase = ""
    @Published var busy = false
    @Published var completed = false
    @Published var message = setupText("Choose your existing Hermes home. No changes will be made yet.")
    @Published var details = ""
    @Published var showDetails = false
    @Published var phaseStartedAt: Date?
    @Published var plan: InstallPlan?
    private var approvedArguments: [String] = []
    private var approvedPython = ""
    private let payload: URL
    private let runner: SetupRunner

    init(payload: URL = Bundle.main.resourceURL!.appendingPathComponent("distribution"),
         runner: @escaping SetupRunner = { python, args, progress, completion in
             runInstaller(python: python, arguments: args, progress: progress, completion: completion)
         }) {
        self.payload = payload; self.runner = runner
    }

    func reset() {
        profiles = []; selected = []; plan = nil; consent = false; completed = false; outcome = nil; phase = ""
        details = ""; showDetails = false; approvedArguments = []; approvedPython = ""
    }

    // AppKit is used only for the folder/file chooser. All wizard state lives here.
    func choosePath(directory: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = directory
        panel.canChooseFiles = !directory
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.message = directory ? setupText("Choose the Hermes home containing config.yaml, not the PLUR1BUS package folder.") : setupText("Choose Python from the existing Hermes virtual environment.")
        if panel.runModal() == .OK, let url = panel.url {
            reset()
            if directory { home = url.path; python = "" } else { python = url.path }
        }
    }

    func detect() {
        reset()
        home = NSString(string: home).expandingTildeInPath
        if python.isEmpty || python == automaticPython {
            do { python = try discoverHermesPython(home: home) ?? "" }
            catch { message = error.localizedDescription; return }
            automaticPython = python
        }
        python = NSString(string: python).expandingTildeInPath
        guard FileManager.default.isExecutableFile(atPath: python) else {
            message = setupText("Hermes Python was not found. Set up Hermes first or use “Choose Python” to select its virtual environment’s Python.")
            return
        }
        busy = true; message = setupText("Checking existing profiles …")
        runner(python, baseArguments() + ["--inspect-profiles"], nil) { code, output, errors in
            self.busy = false
            guard code == 0 else { self.message = setupText("Could not read profiles. Nothing was installed."); self.details = errors; return }
            do {
                let inventory = try JSONDecoder().decode(Inventory.self, from: Data(output.utf8))
                self.profiles = inventory.profiles
                self.selected = Set(inventory.profiles.map(\.name))
                self.message = setupText("Select profiles, then review the installation plan.")
            } catch { self.message = setupText("The profile check returned an invalid response."); self.details = error.localizedDescription }
        }
    }

    private func baseArguments() -> [String] {
        // The signed app bundle must stay immutable, including Python imports.
        // The bootstrap interpreter only starts the installer. Hermes PM owns
        // the target generation; only a user-selected path is an override.
        let args = ["-I", "-B", payload.appendingPathComponent("installer.py").path, "--bundle", payload.path, "--home", home]
        return python == automaticPython ? args : args + ["--python", python]
    }

    func preview() {
        guard !selected.isEmpty else { return }
        let args = baseArguments() + selected.sorted().flatMap { ["--profile", $0] } + (activate ? ["--activate"] : [])
        busy = true; details = ""; message = setupText("Checking the package, profiles and Python environment. Nothing is being installed yet …")
        let interpreter = python
        runner(interpreter, args, nil) { code, output, errors in
            self.busy = false
            guard code == 0 else { self.message = setupText("Preflight checks failed. Nothing was installed."); self.details = errors; return }
            do {
                self.plan = try JSONDecoder().decode(InstallPlan.self, from: Data(output.utf8))
                self.approvedArguments = args; self.approvedPython = interpreter
                self.details = output
                self.message = setupText("Review your selection and authorize the managed shutdown.")
            } catch { self.message = setupText("Invalid installation plan."); self.details = error.localizedDescription }
        }
    }

    func cancelReview() { plan = nil; consent = false }

    func install() {
        guard let plan = plan, consent, !busy else { return }
        let args = approvedArguments + ["--apply", "--confirm", plan.confirmation, "--stop-runtimes", "--progress"]
        runOperation(python: approvedPython, args: args, retainOutcome: false)
    }

    func retry() {
        guard let result = outcome, result.recoveryAvailable == true,
              let receipt = result.receipt, !busy else { return }
        let interpreter: String
        do {
            interpreter = python == automaticPython ? try discoverHermesPython(home: home) ?? "" : python
        } catch { message = error.localizedDescription; return }
        guard FileManager.default.isExecutableFile(atPath: interpreter) else {
            message = setupText("Hermes Python could not be found for the retry."); return
        }
        let args = ["-I", "-B", payload.appendingPathComponent("installer.py").path, "--bundle", payload.path,
                    "--home", home, "--restore-runtimes", URL(fileURLWithPath: receipt).lastPathComponent, "--progress"]
        runOperation(python: interpreter, args: args, retainOutcome: true)
    }

    private func runOperation(python: String, args: [String], retainOutcome: Bool) {
        if !retainOutcome { outcome = nil }
        var operationOutcome: InstallProgress?
        busy = true; showDetails = false; phaseStartedAt = Date(); phase = ""
        message = setupText("Checking the installation plan and running Hermes processes …")
        let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "PLUR1BUS installation")
        runner(python, args, { event in
            if event.phase == "installation-outcome" { operationOutcome = event; self.outcome = event }
            if let message = event.message {
                if self.phase != event.phase { self.phase = event.phase; self.phaseStartedAt = Date() }
                self.message = message
            }
        }) { code, output, errors in
            ProcessInfo.processInfo.endActivity(activity)
            self.busy = false; self.phaseStartedAt = nil
            self.details = errors + "\n" + output
            switch operationOutcome?.status {
            case "installed-restored":
                self.completed = true
                self.message = (operationOutcome?.runtimes?.original?.contains { $0.kind != "cli" } == true)
                    ? setupText("Installation verified. The original Hermes applications and services were reopened.")
                    : setupText("Installation verified. No running Hermes applications or services needed reopening.")
            case "installed-restart-failed":
                self.completed = true
                self.message = setupText("Installation verified, but some Hermes applications or services could not be reopened.")
            case "refused-restored":
                self.message = setupText("Installation was refused before changes. The original Hermes applications and services were restored.")
            case "refused-recovery-required":
                self.message = setupText("Installation was refused before changes, but Hermes could not be fully restored.")
            case "install-failed-recovery-required":
                self.message = setupText("Installation did not complete and may be partial. Review the recovery details before restarting Hermes.")
            case "rollback-restored":
                self.message = setupText("The verified rollback was restored and Hermes applications and services were reopened.")
            default:
                self.message = code == 0 ? setupText("Operation completed. Review the details.") : setupText("Operation did not complete. Review the details before retrying.")
            }
            if code != 0 { self.showDetails = true }
        }
    }

}

class SetupDelegate: NSObject, NSApplicationDelegate {
    weak var model: SetupModel?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if model?.busy == true {
            let alert = NSAlert()
            alert.messageText = setupText("Please wait for the current operation to finish.")
            alert.informativeText = setupText("Setup cannot quit during a check or installation.")
            alert.runModal()
            return .terminateCancel
        }
        return .terminateNow
    }
}

struct SetupView: View {
    @ObservedObject var model: SetupModel
    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 14) {
            Text(setupText("Set up PLUR1BUS for Hermes")).font(.title)
            Text(setupText("1 · Find Hermes    →    2 · Select profiles    →    3 · Review and install")).foregroundColor(.secondary)
            Text(setupText("The PKG installs this assistant. Use it to set up PLUR1BUS for your profiles, without a terminal or administrator privileges."))
            if model.plan == nil && !model.completed && model.outcome == nil {
                HStack {
                    TextField(setupText("Hermes home"), text: $model.home).onChange(of: model.home) { _ in model.reset() }
                    Button(setupText("Choose folder …")) { model.choosePath(directory: true) }
                }
                HStack {
                    TextField(setupText("Hermes virtual environment Python (automatic)"), text: $model.python).onChange(of: model.python) { _ in model.reset() }
                    Button(setupText("Choose Python …")) { model.choosePath(directory: false) }
                }
                Button(setupText("Find profiles")) { model.detect() }
                if !model.profiles.isEmpty {
                    HStack {
                        Button(setupText("All existing profiles")) { model.selected = Set(model.profiles.map(\.name)) }
                        Button(setupText("Default profile only")) { model.selected = ["default"] }
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(model.profiles) { profile in
                                Toggle(isOn: Binding(get: { model.selected.contains(profile.name) }, set: { on in
                                    if on { model.selected.insert(profile.name) } else { model.selected.remove(profile.name) }
                                })) {
                                    HStack { Text(profile.label); Spacer(); Text(profile.status).font(.caption).foregroundColor(.secondary) }
                                }
                            }
                        }.padding(6)
                    }.frame(height: 150)
                    Text(setupText("Selected: %ld of %ld. Run setup again for profiles created later.", model.selected.count, model.profiles.count)).font(.caption)
                    Toggle(setupText("Activate PLUR1BUS for the selected profiles (recommended)"), isOn: $model.activate)
                    Text(model.activate ? setupText("Selects PLUR1BUS as the memory provider and activates its Agent plugin. Replaces the current provider selection; Desktop preferences are preserved.")
                         : setupText("Install or update files only. The PLUR1BUS button appears only if PLUR1BUS is already activated.")).font(.caption)
                    Button(setupText("Review installation plan")) { model.preview() }.disabled(model.selected.isEmpty)
                }
            }
            if let plan = model.plan, !model.completed, model.outcome == nil {
                Text(setupText("Version: %@", plan.version)).font(.headline)
                Text(setupText("Hermes home: %@", model.home))
                Text(setupText("Profiles: %@", plan.profiles.joined(separator: ", ")))
                Text(plan.activate ? setupText("Install AND activate") : setupText("Install only — preserve activation")).bold()
                Text(setupText("Dependencies will be installed in the shared Hermes environment. Changed plugin and configuration files will be backed up. This does not back up the entire environment."))
                Text(setupText("This does not switch models, download model weights or migrate memory. Existing memories are preserved. Models and credentials must be configured separately."))
                ForEach(plan.warnings, id: \.self) { Text($0).foregroundColor(.orange) }
                Text(setupText("Save unsent work. Setup will close selected local Desktop, gateways and CLI sessions, install, then reopen the original Desktop and services. Running replies and jobs may finish within Hermes’ normal shutdown interval, then may be interrupted. Saved CLI sessions remain resumable; commands and jobs are not replayed."))
                Toggle(setupText("I authorize closing and reopening these Hermes runtimes."), isOn: $model.consent)
                HStack {
                    Button(setupText("Back to selection")) { model.cancelReview() }
                    Button(plan.activate ? setupText("Stop, install and activate") : setupText("Stop and install files")) { model.install() }.disabled(!model.consent)
                }
            }
            if model.busy { ProgressView().controlSize(.small) }
            Text(model.message).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("setup-status")
            if let start = model.phaseStartedAt {
                HStack { Text(setupText("Time in this step")); Text(start, style: .timer).monospacedDigit() }
                    .font(.caption).foregroundColor(.secondary)
            }
            if model.outcome != nil && !model.completed {
                Button(setupText("Start a new plan")) { model.reset() }
            }
            if model.outcome?.recoveryAvailable == true {
                Button(setupText("Retry reopening Hermes")) { model.retry() }
            }
            if model.completed {
                Text(setupText("The Agent and memory provider are activated only if selected. Existing Desktop preferences are preserved. If the navigation entry is absent, open Hermes → Capabilities → Plugins → PLUR1BUS and enable Desktop. A configured embedding provider is required to save and recall memories."))
                Button(setupText("Set up more profiles")) { model.reset() }
            }
            if !model.details.isEmpty {
                DisclosureGroup(setupText("Technical details / installation receipt"), isExpanded: $model.showDetails) {
                    ScrollView { Text(model.details).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 140)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(24).frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: 740, height: 720).disabled(model.busy)
    }
}

#if !SETUP_TESTING
@main struct PLUR1BUSSetup: App {
    @StateObject private var model = SetupModel()
    @NSApplicationDelegateAdaptor(SetupDelegate.self) private var delegate
    var body: some Scene {
        WindowGroup(setupText("PLUR1BUS Setup")) {
            SetupView(model: model).onAppear { delegate.model = model }
        }.windowStyle(.titleBar)
        .commands { CommandGroup(replacing: .newItem) {} }
    }
}

#endif
