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

struct InstallProgress: Decodable {
    let phase: String
    let profile: String?
    let completed: Int?
    let total: Int?

    var message: String? {
        switch phase {
        case "preparing": return setupText("Preparing installation and backing up files …")
        case "installing-dependencies": return setupText("Installing Python dependencies …")
        case "admitting-pm-profile":
            guard let profile = profile, let completed = completed, let total = total,
                  completed >= 0, completed < total else { return nil }
            return setupText("Hermes is setting up profile %@ (%ld of %ld) …", profile, completed + 1, total)
        case "verifying": return setupText("Verifying files, Python imports and profile activation …")
        default: return nil
        }
    }
}

// No shell is involved. Output stays in private temporary files, so a long pip
// run cannot deadlock on a full pipe or block the main/UI thread.
func runInstaller(python: String, arguments: [String], progress: ((InstallProgress) -> Void)? = nil,
                  completion: @escaping (Int32, String, String) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("plur1bus-setup-\(UUID().uuidString)")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer {
                do { try FileManager.default.removeItem(at: directory) }
                catch { NSLog("PLUR1BUS: temporary setup output could not be removed: %@", error.localizedDescription) }
            }
            let stdout = directory.appendingPathComponent("stdout")
            let stderr = directory.appendingPathComponent("stderr")
            for url in [stdout, stderr] {
                guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                    throw NSError(domain: "PLUR1BUS", code: 1, userInfo: [NSLocalizedDescriptionKey: setupText("Could not create temporary output.")])
                }
            }
            let out = try FileHandle(forWritingTo: stdout), err = try FileHandle(forWritingTo: stderr)
            defer { out.closeFile(); err.closeFile() }
            let reader = try progress.map { _ in try FileHandle(forReadingFrom: stderr) }
            defer { reader?.closeFile() }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: python)
            process.arguments = arguments
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = out
            process.standardError = err
            try process.run()
            if let reader = reader, let progress = progress {
                let prefix = Data("PLUR1BUS_PROGRESS ".utf8)
                var pending = Data()
                while process.isRunning {
                    do { pending.append(try reader.read(upToCount: 4096) ?? Data()) }
                    catch {
                        NSLog("PLUR1BUS: progress output could not be read: %@", error.localizedDescription)
                        break
                    }
                    while let end = pending.firstIndex(of: 10) {
                        let line = pending.prefix(upTo: end)
                        if line.starts(with: prefix),
                           let event = try? JSONDecoder().decode(InstallProgress.self, from: line.dropFirst(prefix.count)) {
                            DispatchQueue.main.async { progress(event) }
                        }
                        pending.removeFirst(line.count + 1)
                    }
                    if pending.count > 4096 { pending.removeAll() }
                    Thread.sleep(forTimeInterval: 0.25)
                }
            }
            process.waitUntilExit()
            let output = try String(contentsOf: stdout, encoding: .utf8)
            let errors = try String(contentsOf: stderr, encoding: .utf8)
            DispatchQueue.main.async { completion(process.terminationStatus, output, errors) }
        } catch {
            let message = error.localizedDescription
            DispatchQueue.main.async { completion(4, "", message) }
        }
    }
}

final class SetupModel: ObservableObject {
    @Published var home = ProcessInfo.processInfo.environment["HERMES_HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".hermes").path
    @Published var python = ""
    private var automaticPython = ""
    @Published var profiles: [Profile] = []
    @Published var selected: Set<String> = []
    @Published var activate = true
    @Published var stopped = false
    @Published var busy = false
    @Published var completed = false
    @Published var message = setupText("Choose your existing Hermes home. No changes will be made yet.")
    @Published var details = ""
    @Published var showDetails = false
    @Published var phaseStartedAt: Date?
    @Published var plan: InstallPlan?
    private var approvedArguments: [String] = []
    private var approvedPython = ""
    private let payload = Bundle.main.resourceURL!.appendingPathComponent("distribution")

    func reset() {
        profiles = []; selected = []; plan = nil; stopped = false; completed = false
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
        runInstaller(python: python, arguments: baseArguments() + ["--inspect-profiles"]) { code, output, errors in
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
        runInstaller(python: interpreter, arguments: args) { code, output, errors in
            self.busy = false
            guard code == 0 else { self.message = setupText("Preflight checks failed. Nothing was installed."); self.details = errors; return }
            do {
                self.plan = try JSONDecoder().decode(InstallPlan.self, from: Data(output.utf8))
                self.approvedArguments = args; self.approvedPython = interpreter
                self.details = output
                self.message = setupText("Review your selection and stop all affected Hermes runtimes.")
            } catch { self.message = setupText("Invalid installation plan."); self.details = error.localizedDescription }
        }
    }

    func install() {
        guard let plan = plan, stopped, !busy else { return }
        busy = true; showDetails = false; phaseStartedAt = Date()
        message = setupText("Checking the installation plan and running Hermes processes …")
        let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "PLUR1BUS installation")
        let args = approvedArguments + ["--apply", "--confirm", plan.confirmation, "--runtimes-stopped", "--progress"]
        runInstaller(python: approvedPython, arguments: args, progress: { event in
            guard let message = event.message else { return }
            self.message = message; self.phaseStartedAt = Date()
        }) { code, output, errors in
            ProcessInfo.processInfo.endActivity(activity)
            self.busy = false; self.phaseStartedAt = nil
            self.details = errors + "\n" + output
            if code == 0 {
                self.completed = true
                self.message = plan.activate ? setupText("Installed and activation verified: %@. Restart Hermes now.", plan.profiles.joined(separator: ", "))
                    : setupText("Files installed. Existing activation settings were preserved.")
            } else {
                self.message = setupText("Installation did not complete. Check the details and backup journal. If dependencies failed, do not restart Hermes yet. Create a new plan before trying again.")
                self.showDetails = true; self.plan = nil; self.stopped = false
            }
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
        VStack(alignment: .leading, spacing: 14) {
            Text(setupText("Set up PLUR1BUS for Hermes")).font(.title)
            Text(setupText("1 · Find Hermes    →    2 · Select profiles    →    3 · Review and install")).foregroundColor(.secondary)
            Text(setupText("The PKG installs this assistant. Use it to set up PLUR1BUS for your profiles, without a terminal or administrator privileges."))
            if model.plan == nil && !model.completed {
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
                    Text(model.activate ? setupText("Selects PLUR1BUS as the memory provider and activates its main plugin, dashboard and controls. Replaces the current provider selection.")
                         : setupText("Install or update files only. The PLUR1BUS button appears only if PLUR1BUS is already activated.")).font(.caption)
                    Button(setupText("Review installation plan")) { model.preview() }.disabled(model.selected.isEmpty)
                }
            }
            if let plan = model.plan, !model.completed {
                Text(setupText("Version: %@", plan.version)).font(.headline)
                Text(setupText("Hermes home: %@", model.home))
                Text(setupText("Profiles: %@", plan.profiles.joined(separator: ", ")))
                Text(plan.activate ? setupText("Install AND activate") : setupText("Install only — preserve activation")).bold()
                Text(setupText("Dependencies will be installed in the shared Hermes environment. Changed plugin and configuration files will be backed up. This does not back up the entire environment."))
                Text(setupText("This does not switch models, download model weights or migrate memory. Existing memories are preserved. Models and credentials must be configured separately."))
                ForEach(plan.warnings, id: \.self) { Text($0).foregroundColor(.orange) }
                Toggle(setupText("Desktop, gateway, CLI and jobs using this Hermes environment are stopped."), isOn: $model.stopped)
                HStack {
                    Button(setupText("Back to selection")) { model.plan = nil; model.stopped = false }
                    Button(plan.activate ? setupText("Install and activate now") : setupText("Install files only")) { model.install() }.disabled(!model.stopped)
                }
            }
            if model.busy { ProgressView().controlSize(.small) }
            Text(model.message).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("setup-status")
            if let start = model.phaseStartedAt {
                HStack { Text(setupText("Time in this step")); Text(start, style: .timer).monospacedDigit() }
                    .font(.caption).foregroundColor(.secondary)
            }
            if model.completed {
                Text(setupText("After restarting, open each selected profile and check for the PLUR1BUS button. A configured embedding provider is also required to save and recall memories."))
                Button(setupText("Set up more profiles")) { model.reset() }
            }
            if !model.details.isEmpty {
                DisclosureGroup(setupText("Technical details / installation receipt"), isExpanded: $model.showDetails) {
                    ScrollView { Text(model.details).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 140)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(24).frame(width: 740, height: 720).disabled(model.busy)
    }
}

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
