import SwiftUI
import AppKit

struct Profile: Decodable, Identifiable {
    let name: String
    let active: Bool
    let inconsistent: Bool
    var id: String { name }
    var label: String { name == "default" ? "Standardprofil (default)" : name }
    var status: String { active ? "PLUR1BUS aktiviert" : inconsistent ? "Aktivierung unvollständig" : "Noch nicht aktiviert" }
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

// No shell is involved. Output stays in private temporary files, so a long pip
// run cannot deadlock on a full pipe or block the main/UI thread.
func runInstaller(python: String, arguments: [String], completion: @escaping (Int32, String, String) -> Void) {
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
                    throw NSError(domain: "PLUR1BUS", code: 1, userInfo: [NSLocalizedDescriptionKey: "Temporäre Ausgabe konnte nicht angelegt werden."])
                }
            }
            let out = try FileHandle(forWritingTo: stdout), err = try FileHandle(forWritingTo: stderr)
            defer { out.closeFile(); err.closeFile() }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: python)
            process.arguments = arguments
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = out
            process.standardError = err
            try process.run()
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
    @Published var profiles: [Profile] = []
    @Published var selected: Set<String> = []
    @Published var activate = true
    @Published var stopped = false
    @Published var busy = false
    @Published var completed = false
    @Published var message = "Wähle dein vorhandenes Hermes-Home. Es werden noch keine Änderungen vorgenommen."
    @Published var details = ""
    @Published var plan: InstallPlan?
    private var approvedArguments: [String] = []
    private var approvedPython = ""
    private let payload = Bundle.main.resourceURL!.appendingPathComponent("distribution")

    func reset() {
        profiles = []; selected = []; plan = nil; stopped = false; completed = false
        details = ""; approvedArguments = []; approvedPython = ""
    }

    // AppKit is used only for the folder/file chooser. All wizard state lives here.
    func choosePath(directory: Bool) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = directory
        panel.canChooseFiles = !directory
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.message = directory ? "Hermes-Home mit config.yaml auswählen (nicht den PLUR1BUS-Paketordner)." : "Python aus dem vorhandenen Hermes-venv auswählen."
        if panel.runModal() == .OK, let url = panel.url {
            reset()
            if directory { home = url.path; python = "" } else { python = url.path }
        }
    }

    func detect() {
        reset()
        home = NSString(string: home).expandingTildeInPath
        if python.isEmpty {
            python = ["hermes-agent/venv/bin/python", "hermes-agent/.venv/bin/python"]
                .map { URL(fileURLWithPath: home).appendingPathComponent($0).path }
                .first { FileManager.default.isExecutableFile(atPath: $0) } ?? ""
        }
        python = NSString(string: python).expandingTildeInPath
        guard FileManager.default.isExecutableFile(atPath: python) else {
            message = "Hermes-Python nicht gefunden. Hermes zuerst einrichten oder unter ‚Python auswählen‘ das venv-Python angeben."
            return
        }
        busy = true; message = "Vorhandene Profile werden geprüft …"
        runInstaller(python: python, arguments: baseArguments() + ["--inspect-profiles"]) { code, output, errors in
            self.busy = false
            guard code == 0 else { self.message = "Profile konnten nicht gelesen werden. Es wurde nichts installiert."; self.details = errors; return }
            do {
                let inventory = try JSONDecoder().decode(Inventory.self, from: Data(output.utf8))
                self.profiles = inventory.profiles
                self.selected = Set(inventory.profiles.map(\.name))
                self.message = "Profile auswählen und anschließend den Installationsplan prüfen."
            } catch { self.message = "Ungültige Antwort der Profilprüfung."; self.details = error.localizedDescription }
        }
    }

    private func baseArguments() -> [String] {
        // The signed app bundle must stay immutable, including Python imports.
        ["-I", "-B", payload.appendingPathComponent("installer.py").path, "--bundle", payload.path, "--home", home, "--python", python]
    }

    func preview() {
        guard !selected.isEmpty else { return }
        let args = baseArguments() + selected.sorted().flatMap { ["--profile", $0] } + (activate ? ["--activate"] : [])
        busy = true; details = ""; message = "Paket, Profile und Python-Umgebung werden geprüft. Noch keine Installation …"
        let interpreter = python
        runInstaller(python: interpreter, arguments: args) { code, output, errors in
            self.busy = false
            guard code == 0 else { self.message = "Vorprüfung fehlgeschlagen. Es wurde nichts installiert."; self.details = errors; return }
            do {
                self.plan = try JSONDecoder().decode(InstallPlan.self, from: Data(output.utf8))
                self.approvedArguments = args; self.approvedPython = interpreter
                self.details = output
                self.message = "Bitte Auswahl prüfen und alle betroffenen Hermes-Laufzeiten beenden."
            } catch { self.message = "Ungültiger Installationsplan."; self.details = error.localizedDescription }
        }
    }

    func install() {
        guard let plan = plan, stopped, !busy else { return }
        busy = true; message = "Installation läuft. Abhängigkeiten können mehrere Minuten benötigen. Bitte nicht beenden."
        let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .idleSystemSleepDisabled], reason: "PLUR1BUS installation")
        runInstaller(python: approvedPython, arguments: approvedArguments + ["--apply", "--confirm", plan.confirmation, "--runtimes-stopped"]) { code, output, errors in
            ProcessInfo.processInfo.endActivity(activity)
            self.busy = false; self.details = output + "\n" + errors
            if code == 0 {
                self.completed = true
                self.message = plan.activate ? "Installiert und Aktivierung geprüft: \(plan.profiles.joined(separator: ", ")). Hermes jetzt neu starten."
                    : "Dateien installiert. Die bisherige Aktivierung wurde unverändert gelassen."
            } else {
                self.message = "Installation nicht abgeschlossen. Details und Backup-Journal prüfen; bei einem Abhängigkeitsfehler Hermes noch nicht neu starten. Vor erneutem Versuch einen neuen Plan erstellen."
                self.plan = nil; self.stopped = false
            }
        }
    }
}

class SetupDelegate: NSObject, NSApplicationDelegate {
    weak var model: SetupModel?
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if model?.busy == true {
            let alert = NSAlert()
            alert.messageText = "Bitte den laufenden Vorgang abwarten."
            alert.informativeText = "Die Einrichtung wird nicht mitten in einer Prüfung oder Installation beendet."
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
            Text("PLUR1BUS für Hermes einrichten").font(.title)
            Text("1 · Hermes finden    →    2 · Profile auswählen    →    3 · Prüfen und installieren").foregroundColor(.secondary)
            Text("Das PKG installiert diesen Assistenten. Erst hier richtest du PLUR1BUS für deine Profile ein – ohne Terminal und ohne Administratorrechte.")
            if model.plan == nil && !model.completed {
                HStack {
                    TextField("Hermes-Home", text: $model.home).onChange(of: model.home) { _ in model.reset() }
                    Button("Ordner auswählen …") { model.choosePath(directory: true) }
                }
                HStack {
                    TextField("Hermes-venv-Python (automatisch)", text: $model.python).onChange(of: model.python) { _ in model.reset() }
                    Button("Python auswählen …") { model.choosePath(directory: false) }
                }
                Button("Profile erkennen") { model.detect() }
                if !model.profiles.isEmpty {
                    HStack {
                        Button("Alle vorhandenen Profile") { model.selected = Set(model.profiles.map(\.name)) }
                        Button("Nur Standardprofil (default)") { model.selected = ["default"] }
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
                    Text("Auswahl: \(model.selected.count) von \(model.profiles.count). Später neu angelegte Profile bitte erneut hier einrichten.").font(.caption)
                    Toggle("PLUR1BUS für die ausgewählten Profile aktivieren (empfohlen)", isOn: $model.activate)
                    Text(model.activate ? "Wählt PLUR1BUS als Memory-Provider und aktiviert Hauptplugin, Dashboard und Controls. Ersetzt die bisherige Provider-Auswahl."
                         : "Nur Dateien installieren/aktualisieren. Ohne bisherige Aktivierung erscheint kein PLUR1BUS-Knopf.").font(.caption)
                    Button("Installationsplan prüfen") { model.preview() }.disabled(model.selected.isEmpty)
                }
            }
            if let plan = model.plan, !model.completed {
                Text("Version: \(plan.version)").font(.headline)
                Text("Hermes-Home: \(model.home)")
                Text("Profile: \(plan.profiles.joined(separator: ", "))")
                Text(plan.activate ? "Installation UND Aktivierung" : "Nur Installation – Aktivierung unverändert").bold()
                Text("Abhängigkeiten im gemeinsamen Hermes-venv werden installiert. Geänderte Plugin- und Konfigurationsdateien werden gesichert. Kein vollständiges venv-Backup.")
                Text("Keine Modellwechsel, Downloads von Modellgewichten oder Memory-Migrationen. Bestehende Erinnerungen bleiben erhalten. Modelle/Zugangsdaten müssen separat eingerichtet sein.")
                ForEach(plan.warnings, id: \.self) { Text($0).foregroundColor(.orange) }
                Toggle("Desktop, Gateway, CLI und Jobs mit diesem Hermes-venv sind beendet.", isOn: $model.stopped)
                HStack {
                    Button("Zurück zur Auswahl") { model.plan = nil; model.stopped = false }
                    Button(plan.activate ? "Jetzt installieren und aktivieren" : "Jetzt nur Dateien installieren") { model.install() }.disabled(!model.stopped)
                }
            }
            if model.busy { ProgressView().controlSize(.small) }
            Text(model.message).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("setup-status")
            if model.completed {
                Text("Nach dem Neustart jedes ausgewählte Profil öffnen und den PLUR1BUS-Knopf prüfen. Ein eingerichteter Embedding-Provider ist zusätzlich für Speichern/Abrufen erforderlich.")
                Button("Weitere Profile einrichten") { model.reset() }
            }
            if !model.details.isEmpty {
                DisclosureGroup("Technische Details / Installationsbeleg") {
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
        WindowGroup("PLUR1BUS einrichten") {
            SetupView(model: model).onAppear { delegate.model = model }
        }.windowStyle(.titleBar)
        .commands { CommandGroup(replacing: .newItem) {} }
    }
}
