import CryptoKit
import Darwin
import Foundation

private enum HermesPythonError: LocalizedError {
    case invalidManagedEnvironment

    var errorDescription: String? {
        setupText("Hermes PM has not selected a usable Python environment. Check the Hermes installation with Hermes PM.")
    }
}

private struct HermesFacts: Decodable {
    struct Packages: Decodable {
        struct Venv: Decodable { let environment: String }
        let venv: Venv
    }
    let packages: Packages
}

private struct HermesRuntimeFacts: Decodable {
    struct Packages: Decodable {
        struct Python: Decodable { let entry: String }
        let python: Python
    }
    let schema: Int
    let packages: Packages
}

private func canonicalPath(_ url: URL) -> String? {
    guard let resolved = realpath(url.path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
}

private func configuredPMExecutable() throws -> String? {
    guard let configured = ProcessInfo.processInfo.environment["HERMES_RUNTIME_DIR"], !configured.isEmpty else { return nil }
    let requested = URL(fileURLWithPath: configured, isDirectory: true)
    let properties = try? requested.resourceValues(forKeys: [.isSymbolicLinkKey])
    guard configured.hasPrefix("/"), properties?.isSymbolicLink == false,
          let path = canonicalPath(requested) else { throw HermesPythonError.invalidManagedEnvironment }
    let root = URL(fileURLWithPath: path, isDirectory: true)
    let facts = root.appendingPathComponent("facts.json")
    guard canonicalPath(facts) == facts.path,
          let data = try? Data(contentsOf: facts),
          let decoded = try? JSONDecoder().decode(HermesRuntimeFacts.self, from: data), decoded.schema == 1 else {
        throw HermesPythonError.invalidManagedEnvironment
    }
    let relative = decoded.packages.python.entry
    let components = relative.components(separatedBy: "/")
    guard !relative.isEmpty, !relative.hasPrefix("/"), !relative.contains(":"), !relative.contains("\\"),
          !components.contains("."), !components.contains("..") else { throw HermesPythonError.invalidManagedEnvironment }
    var entry = root
    for component in components where !component.isEmpty {
        entry.appendPathComponent(component, isDirectory: true)
        guard canonicalPath(entry) == entry.path else { throw HermesPythonError.invalidManagedEnvironment }
    }
    let bin = entry.appendingPathComponent("bin", isDirectory: true)
    // Match configured_pm_python(): trust only PM's canonical binary inside
    // its recorded entry, including its normal versioned POSIX symlink.
    guard canonicalPath(bin) == bin.path,
          let binary = canonicalPath(bin.appendingPathComponent("python3")), binary.hasPrefix(entry.path + "/"),
          try URL(fileURLWithPath: binary).resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
        throw HermesPythonError.invalidManagedEnvironment
    }
    return binary
}

// Match installer.py's read-only lookup. Invoke the lexical venv Python so
// CPython uses that generation's pyvenv.cfg even if the binary is a symlink.
func discoverHermesPython(home: String) throws -> String? {
    let files = FileManager.default
    // Foundation's symlink resolution can prefer /var over /private/var.
    // Use the same POSIX path identity as Python's Path.resolve() for the key.
    guard let path = canonicalPath(URL(fileURLWithPath: home, isDirectory: true)) else { return nil }
    let root = URL(fileURLWithPath: path, isDirectory: true)
    let project = root.appendingPathComponent("hermes-agent", isDirectory: true)
    let key = SHA256.hash(data: Data(project.path.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    let state = root.appendingPathComponent("installs/\(key)", isDirectory: true)
    let facts = state.appendingPathComponent("facts.json")
    if files.fileExists(atPath: facts.path) {
        guard canonicalPath(project) == project.path,
              canonicalPath(facts) == facts.path,
              try facts.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true,
              let data = try? Data(contentsOf: facts),
              let decoded = try? JSONDecoder().decode(HermesFacts.self, from: data),
              decoded.packages.venv.environment.hasPrefix("/") else {
            throw HermesPythonError.invalidManagedEnvironment
        }
        let generation = URL(fileURLWithPath: decoded.packages.venv.environment, isDirectory: true)
        let environments = state.appendingPathComponent("environments", isDirectory: true)
        let bin = generation.appendingPathComponent("bin", isDirectory: true)
        let candidate = bin.appendingPathComponent("python")
        let tools = root.appendingPathComponent("tools", isDirectory: true)
        guard let executable = canonicalPath(candidate) else { throw HermesPythonError.invalidManagedEnvironment }
        let withinGeneration = executable.hasPrefix(generation.path + "/")
        let withinTools = canonicalPath(tools) == tools.path && executable.hasPrefix(tools.path + "/")
        var trusted = withinGeneration || withinTools
        if !trusted { trusted = try configuredPMExecutable() == executable }
        guard generation.path.hasPrefix(environments.path + "/"),
              canonicalPath(bin) == bin.path,
              files.fileExists(atPath: generation.appendingPathComponent("pyvenv.cfg").path),
              trusted,
              try URL(fileURLWithPath: executable).resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true,
              files.isExecutableFile(atPath: candidate.path) else {
            throw HermesPythonError.invalidManagedEnvironment
        }
        return candidate.path
    }
    return ["venv/bin/python", ".venv/bin/python"].map { project.appendingPathComponent($0).path }
        .first { files.isExecutableFile(atPath: $0) }
}
