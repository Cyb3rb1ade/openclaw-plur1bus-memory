import Foundation

@main struct Probe {
    static func main() throws {
        let home = CommandLine.arguments[1]
        let facts = CommandLine.arguments[2]
        let oldPython = CommandLine.arguments[3]
        let newPython = CommandLine.arguments[4]
        let newGeneration = URL(fileURLWithPath: newPython).deletingLastPathComponent().deletingLastPathComponent().path
        var calls: [(String, [String])] = []
        var status = "installed-restart-failed"
        var eligible = true
        var retryEmits = false
        let runner: SetupRunner = { python, args, progress, completion in
            calls.append((python, args))
            if args.contains("--inspect-profiles") {
                completion(0, "{\"profiles\":[{\"name\":\"default\",\"active\":false,\"inconsistent\":false}]}", "")
            } else if !args.contains("--apply") && !args.contains("--restore-runtimes") {
                completion(0, "{\"version\":\"1\",\"profiles\":[\"default\"],\"confirmation\":\"hash\",\"activate\":true,\"effects\":\"\",\"warnings\":[]}", "")
            } else if args.contains("--restore-runtimes") && !retryEmits {
                completion(4, "", "launch failed")
            } else {
                let data = try! JSONSerialization.data(withJSONObject: ["phase":"installation-outcome", "status":status, "receipt":"/tmp/receipt-1", "recoveryAvailable":eligible])
                progress?(try! JSONDecoder().decode(InstallProgress.self, from: data))
                completion(status == "installed-restored" ? 0 : 4, "", "failure")
            }
        }
        let model = SetupModel(payload: URL(fileURLWithPath: "/tmp/payload"), runner: runner)
        model.home = home
        model.detect(); model.preview()
        precondition(model.python == oldPython && model.plan != nil)
        let before = calls.count
        model.install()
        precondition(calls.count == before, "install requires consent")
        model.consent = true; model.cancelReview(); model.install()
        precondition(calls.count == before && model.plan == nil, "cancel must prevent writes")
        model.preview(); model.consent = true; model.install()
        precondition(calls.last!.1.contains("--stop-runtimes") && model.completed)
        precondition(model.outcome?.recoveryAvailable == true && model.message.contains("Installation verified"))
        try FileManager.default.removeItem(atPath: oldPython)
        let factsData = try JSONSerialization.data(withJSONObject: ["packages":["venv":["environment":newGeneration]]])
        try factsData.write(to: URL(fileURLWithPath: facts))
        model.retry()
        precondition(calls.last!.0 == newPython, "retry must rediscover selected PM Python")
        precondition(calls.last!.1.contains("receipt-1"), "retry must use approved receipt")
        precondition(model.outcome?.recoveryAvailable == true && model.outcome?.receipt == "/tmp/receipt-1", "early retry failure must preserve receipt")
        precondition(model.message.contains("did not complete"), "early failure must not report old success")
        retryEmits = true; status = "installed-restored"; eligible = false
        model.retry()
        precondition(model.outcome?.status == "installed-restored" && model.outcome?.recoveryAvailable == false)
        let after = calls.count; model.retry(); precondition(calls.count == after, "ineligible retry must not run")
        for (value, expected, allow) in [("refused-restored", "refused before changes", false),
                                         ("refused-recovery-required", "refused before changes", true),
                                         ("install-failed-recovery-required", "may be partial", false)] {
            status = value; eligible = allow
            model.reset(); model.python = ""; model.detect(); model.preview(); model.consent = true; model.install()
            precondition(model.message.contains(expected), "incorrect outcome: \(value)")
            precondition(model.outcome?.recoveryAvailable == allow && !model.completed)
            if allow {
                retryEmits = false
                model.retry()
                precondition(model.outcome?.status == value && model.outcome?.recoveryAvailable == true,
                             "early retry failure must preserve refusal receipt")
                precondition(model.details.contains("launch failed") && model.message.contains("did not complete"))
                retryEmits = true
            }
            if !allow { let n = calls.count; model.retry(); precondition(calls.count == n) }
        }
        print("model lifecycle contracts passed")
    }
}
