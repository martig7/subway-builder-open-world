import SwiftUI
import AppKit
import ServiceManagement

struct World: Identifiable {
    let id: String
    let name: String
    let installed: Bool
    let download: Int64
    let size: Int64
    let free: Int64
}

@MainActor final class ManagerModel: ObservableObject {
    @Published var worlds: [World] = []
    @Published var selected: Set<String> = []
    @Published var version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
    @Published var installing = false
    @Published var busy = false
    @Published var message = ""
    @Published var item = ""
    @Published var fraction = 0.0
    @Published var transfer = ""
    @Published var serverStatus = "Checking…"
    @Published var error: String?
    @Published var confirmUninstall = false
    @Published var confirmCancel = false
    @Published var login = SMAppService.mainApp.status == .enabled
    @Published var localAssets: URL?
    var process: Process?
    var input: Pipe?
    var gameRoot = ""
    var logRoot = ""
    var snapshot = false
    var operation = ""
    var selectedWorld: String { selected.sorted().first ?? worlds.first?.id ?? "" }
    var installed: Bool { worlds.contains { $0.installed } }
    var chosen: [World] { worlds.filter { selected.contains($0.id) } }
    func size(_ bytes: Int64) -> String { ByteCountFormatter.string(fromByteCount: bytes, countStyle: .binary) }
    func boot() {
        if let index = CommandLine.arguments.firstIndex(of: "--snapshot"), CommandLine.arguments.count > index + 1,
           ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" {
            snapshot = true
            setSnapshot(CommandLine.arguments[index + 1]); return
        }
        run("catalog")
    }
    func run(_ command: String, _ arguments: [String] = []) {
        guard !busy, !snapshot else { return }
        busy = true; operation = command
        if command != "catalog" && command != "status" { message = "Working…"; fraction = 0; item = ""; transfer = "" }
        let task = Process()
        task.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/open-world-manager-backend")
        task.arguments = [command] + arguments
        var environment = ProcessInfo.processInfo.environment
        if let localAssets { environment["OPEN_WORLD_ASSET_ROOT"] = localAssets.path }
        task.environment = environment
        let output = Pipe(); let errors = Pipe(); let input = Pipe()
        task.standardOutput = output; task.standardError = errors; task.standardInput = input
        self.input = input; process = task
        let buffer = LineBuffer()
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            for line in buffer.consume(data) {
                guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                DispatchQueue.main.async { self.receive(object) }
            }
        }
        let errorBuffer = LineBuffer()
        errors.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            for line in errorBuffer.consume(data) {
                DispatchQueue.main.async { self.error = String(decoding: line, as: UTF8.self) }
            }
        }
        task.terminationHandler = { task in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                self.busy = false; self.process = nil; self.input = nil
                if task.terminationStatus != 0 && self.error == nil && task.terminationStatus != 2 {
                    self.error = "The operation could not finish (error \(task.terminationStatus)). Open logs for details."
                }
                if ["install", "repair", "uninstall"].contains(command) && task.terminationStatus == 0 {
                    self.installing = false; self.run("catalog")
                } else if command == "catalog" {
                    self.run("status")
                } else if ["start", "stop", "restart"].contains(command) {
                    self.run("status")
                }
            }
        }
        do { try task.run() } catch { self.error = error.localizedDescription; busy = false; process = nil; self.input = nil }
    }
    func receive(_ object: [String: Any]) {
        switch object["type"] as? String {
        case "catalog":
            guard let data = object["data"] as? [String: Any], let list = data["worlds"] as? [[String: Any]] else { return }
            version = data["version"] as? String ?? version
            gameRoot = data["gameRoot"] as? String ?? ""; logRoot = data["logRoot"] as? String ?? ""
            worlds = list.compactMap { w in
                guard let id = w["id"] as? String, let name = w["name"] as? String else { return nil }
                return World(id: id, name: name, installed: w["installed"] as? Bool ?? false,
                             download: (w["downloadBytes"] as? NSNumber)?.int64Value ?? 0,
                             size: (w["installedBytes"] as? NSNumber)?.int64Value ?? 0,
                             free: (w["requiredFreeBytes"] as? NSNumber)?.int64Value ?? 0)
            }
            if selected.isEmpty, let first = worlds.first { selected = [first.id] }
            installing = !installed
        case "status": serverStatus = object["message"] as? String ?? "Unknown"
        case "progress":
            message = object["message"] as? String ?? "Installing"
            item = object["item"] as? String ?? ""
            fraction = object["fraction"] as? Double ?? 0
            transfer = "\(size((object["bytes"] as? NSNumber)?.int64Value ?? 0)) / \(size((object["totalBytes"] as? NSNumber)?.int64Value ?? 0))"
        case "error": error = object["message"] as? String ?? "Operation failed."
        case "cancelled": message = object["message"] as? String ?? "Cancelled"
        case "complete": if operation != "catalog" && operation != "status" { message = "Complete" }
        default: break
        }
    }
    func cancel() { try? input?.fileHandleForWriting.write(contentsOf: Data("cancel\n".utf8)); message = "Cancelling…" }
    func setLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            login = SMAppService.mainApp.status == .enabled
            if enabled && !login { error = "Allow Open World Manager in System Settings → General → Login Items." }
        } catch { self.error = error.localizedDescription }
    }
    func pickAssets() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false
        panel.prompt = "Use folder"; panel.message = "Choose a folder containing the release ZIPs."
        if panel.runModal() == .OK { localAssets = panel.url }
    }
    func openLogs() {
        guard !logRoot.isEmpty else { return }
        try? FileManager.default.createDirectory(atPath: logRoot, withIntermediateDirectories: true)
        NSWorkspace.shared.open(URL(fileURLWithPath: logRoot))
    }
    func setSnapshot(_ state: String) {
        worlds = [World(id: "northeast-corridor-open-world", name: "Northeast Corridor Open World", installed: state != "installer", download: 3_805_582_499, size: 3_805_547_955, free: 8_892_346_606)]
        selected = [worlds[0].id]; installing = ["installer", "progress", "cancel"].contains(state)
        serverStatus = "Running — 34 tile packages"
        if ["progress", "cancel"].contains(state) { busy = true; operation = "install"; message = "Downloading release files"; item = "nec-map-part-03-of-04-v0.5.0.zip"; fraction = 0.62; transfer = "2.2 GB / 3.5 GB" }
        if state == "error" { error = "The tile server could not start because port 8799 is already in use. Close the other tile server and try again." }
        if state == "complete" { message = "Complete"; serverStatus = "Stopped" }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            if state == "cancel" { self.confirmCancel = true }
            if state == "uninstall" { self.confirmUninstall = true }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            guard let root = ProcessInfo.processInfo.environment["UI_SNAPSHOT_ROOT"], let window = NSApp.windows.first(where: { $0.isVisible }) else { return }
            try? String(window.windowNumber).write(toFile: root + "/window-id", atomically: true, encoding: .utf8)
        }
    }
}

final class LineBuffer: @unchecked Sendable {
    private var buffer = Data()
    func consume(_ bytes: Data) -> [Data] {
        buffer.append(bytes); var lines: [Data] = []
        while let newline = buffer.firstIndex(of: 10) { lines.append(buffer[..<newline]); buffer.removeSubrange(...newline) }
        return lines
    }
}

struct MainView: View {
    @ObservedObject var model: ManagerModel
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Text(model.installing ? "Install Subway Builder Open World" : "Open World Manager").font(.title2).fontWeight(.semibold)
                Text("Version \(model.version)").foregroundStyle(.secondary)
            }
            Divider()
            if model.installing {
                GroupBox("Worlds") {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(model.worlds) { world in
                            Toggle(world.name, isOn: Binding(get: { model.selected.contains(world.id) }, set: { if $0 { model.selected.insert(world.id) } else { model.selected.remove(world.id) } })).disabled(model.busy)
                        }
                        Divider()
                        Text("Download: \(model.size(model.chosen.reduce(0) { $0 + $1.download }))   ·   Installed: \(model.size(model.chosen.reduce(0) { $0 + $1.size }))")
                        Text("Free space required: \(model.size(model.chosen.reduce(0) { $0 + $1.free }))").foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
                HStack {
                    Button("Use downloaded files…") { model.pickAssets() }.disabled(model.busy)
                    if let folder = model.localAssets { Text(folder.lastPathComponent).foregroundStyle(.secondary).lineLimit(1) }
                }
            } else {
                Picker("World", selection: Binding(get: { model.selectedWorld }, set: { model.selected = [$0] })) {
                    ForEach(model.worlds) { Text($0.name + ($0.installed ? "" : " (not installed)")).tag($0.id) }
                }.disabled(model.busy)
                GroupBox("Tile server") {
                    VStack(alignment: .leading, spacing: 14) {
                        Label(model.serverStatus, systemImage: model.serverStatus.hasPrefix("Running") ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(model.serverStatus.hasPrefix("Running") ? Color.green : Color.secondary)
                        HStack {
                            Button("Start") { model.run("start") }.disabled(model.serverStatus.hasPrefix("Running"))
                            Button("Stop") { model.run("stop") }.disabled(model.serverStatus == "Stopped")
                            Button("Restart") { model.run("restart") }
                            Spacer()
                            Button("Open logs") { model.openLogs() }
                        }.disabled(model.busy)
                    }.padding(8)
                }
                HStack {
                    Button("Verify data") { model.run("verify", [model.selectedWorld]) }
                    Button("Repair") { model.run("repair", [model.selectedWorld]) }
                    Button("Install worlds…") { model.installing = true }
                    Button("Uninstall…") { model.confirmUninstall = true }
                }.disabled(model.busy)
                Toggle("Open manager when I sign in", isOn: Binding(get: { model.login }, set: { model.setLogin($0) })).disabled(model.busy)
                Button("Check for updates") { NSWorkspace.shared.open(URL(string: "https://github.com/martig7/subway-builder-open-world/releases")!) }.buttonStyle(.link)
            }
            Spacer(minLength: 0)
            VStack(alignment: .leading, spacing: 7) {
                Text(model.message).font(.callout)
                if model.busy && !["status", "catalog"].contains(model.operation) {
                    ProgressView(value: model.fraction)
                    Text(model.item).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                    Text(model.transfer).font(.caption).foregroundStyle(.secondary)
                }
            }.frame(minHeight: 62, alignment: .topLeading)
            Divider()
            HStack {
                Text("Giancarlo Martinelli (gcm)").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if model.busy && ["install", "repair", "verify"].contains(model.operation) {
                    Button("Cancel") { model.confirmCancel = true }
                } else if model.installing {
                    if model.installed { Button("Back") { model.installing = false } }
                    Button("Install") { model.run("install", model.selected.sorted()) }.keyboardShortcut(.defaultAction).disabled(model.busy || model.selected.isEmpty)
                }
            }
        }.padding(24).frame(width: 610, height: 480)
        .alert("Operation needs attention", isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.error = nil } })) {
            Button("OK", role: .cancel) { model.error = nil }
            Button("Open logs") { model.openLogs() }
        } message: { Text(model.error ?? "") }
        .alert("Cancel installation?", isPresented: $model.confirmCancel) {
            Button("Keep going", role: .cancel) {}
            Button("Cancel installation", role: .destructive) { model.cancel() }
        } message: { Text("Existing installed files will be preserved. You can retry later.") }
        .alert("Uninstall this world?", isPresented: $model.confirmUninstall) {
            Button("Cancel", role: .cancel) {}
            Button("Uninstall", role: .destructive) { model.run("uninstall", [model.selectedWorld]) }
        } message: { Text("Removes this world's mod and map files. Saved games and other worlds are kept.") }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    static weak var model: ManagerModel?
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if AppDelegate.model?.busy == true { NSSound.beep(); return .terminateCancel }
        return .terminateNow
    }
}

@main struct OpenWorldManagerApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate
    @StateObject var model = ManagerModel()
    var body: some Scene {
        Window("Open World Manager", id: "manager") {
            MainView(model: model).onAppear { AppDelegate.model = model; if model.worlds.isEmpty { model.boot() } }
        }.windowResizability(.contentSize)
        MenuBarExtra("Open World Manager", systemImage: "tram.fill") {
            ManagerMenu(model: model)
        }
    }
}
struct ManagerMenu: View {
    @ObservedObject var model: ManagerModel
    @Environment(\.openWindow) var openWindow
    var body: some View {
        Text(model.serverStatus)
        Button("Open manager") { openWindow(id: "manager"); NSApp.activate(ignoringOtherApps: true) }
        Button("Start tile server") { model.run("start") }.disabled(model.busy)
        Button("Stop tile server") { model.run("stop") }.disabled(model.busy)
        Divider()
        Button("Quit manager") { NSApp.terminate(nil) }.disabled(model.busy)
    }
}
