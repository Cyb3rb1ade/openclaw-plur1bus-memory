import CryptoKit
import Darwin
import Foundation

private enum HermesPythonError: LocalizedError {
    case invalidManagedEnvironment

    var errorDescription: String? {
        "Hermes PM hat keine verwendbare Python-Umgebung ausgewählt. Prüfe die Hermes-Installation mit Hermes PM."
    }
}

private struct HermesFacts: Decodable {
    struct Packages: Decodable {
        struct Venv: Decodable { let environment: String }
        let venv: Venv
    }
    let packages: Packages
}

private func canonicalPath(_ url: URL) -> String? {
    guard let resolved = realpath(url.path, nil) else { return nil }
    defer { free(resolved) }
    return String(cString: resolved)
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
        guard generation.path.hasPrefix(environments.path + "/"),
              canonicalPath(bin) == bin.path,
              files.fileExists(atPath: generation.appendingPathComponent("pyvenv.cfg").path),
              withinGeneration || withinTools,
              try URL(fileURLWithPath: executable).resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true,
              files.isExecutableFile(atPath: candidate.path) else {
            throw HermesPythonError.invalidManagedEnvironment
        }
        return candidate.path
    }
    return ["venv/bin/python", ".venv/bin/python"].map { project.appendingPathComponent($0).path }
        .first { files.isExecutableFile(atPath: $0) }
}
