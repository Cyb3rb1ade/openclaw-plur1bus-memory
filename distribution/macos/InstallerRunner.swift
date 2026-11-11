import Foundation

struct RuntimeSummary: Decodable {
    let original: [RuntimeEntry]?
}
struct RuntimeEntry: Decodable { let kind: String?; let state: String? }

struct InstallProgress: Decodable {
    let phase: String
    let status: String?
    let receipt: String?
    let recoveryAvailable: Bool?
    let runtimes: RuntimeSummary?
    let profile: String?
    let completed: Int?
    let total: Int?

    var message: String? {
        switch phase {
        case "inspecting-runtimes": return setupText("Checking running Hermes applications and services …")
        case "stopping-runtimes": return setupText("Closing selected Hermes applications and services …")
        case "waiting-for-runtimes": return setupText("Waiting for active Hermes work to finish …")
        case "restarting-runtimes": return setupText("Reopening the original Hermes applications and services …")
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
                var discarding = false
                func drain() {
                    do {
                        while let bytes = try reader.read(upToCount: 4096), !bytes.isEmpty {
                            for byte in bytes {
                                if byte == 10 {
                                    if !discarding && pending.starts(with: prefix),
                                       let event = try? JSONDecoder().decode(InstallProgress.self, from: pending.dropFirst(prefix.count)) {
                                        DispatchQueue.main.async { progress(event) }
                                    }
                                    pending.removeAll(keepingCapacity: true); discarding = false
                                } else if !discarding {
                                    pending.append(byte)
                                    if pending.count > 1_048_576 { pending.removeAll(); discarding = true }
                                }
                            }
                        }
                    } catch {
                        NSLog("PLUR1BUS: progress output could not be read: %@", error.localizedDescription)
                    }
                }
                while process.isRunning {
                    drain()
                    Thread.sleep(forTimeInterval: 0.25)
                }
                process.waitUntilExit()
                drain()
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

