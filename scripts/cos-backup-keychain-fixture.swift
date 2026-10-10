// Host-native, disposable credential entry fixture. No owner credentials are read.
import Foundation
import Security
import Darwin
enum FixtureError: Error { case failed }
func request(_ reference: String) -> [String: Any] {
    return [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "nanoclaw-cos-backup-smb/v1",
            kSecAttrAccount as String: reference,
            kSecAttrSynchronizable as String: false]
}
func readItem(_ reference: String) throws -> Data? {
    var query = request(reference)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let value = result as? Data else { throw FixtureError.failed }
    return value
}
func check(_ helper: String, _ entries: [Data], _ success: Bool) throws {
    let reference = UUID().uuidString.lowercased()
    guard try readItem(reference) == nil else { throw FixtureError.failed }
    defer { SecItemDelete(request(reference) as CFDictionary) }
    var master: Int32 = -1, slave: Int32 = -1
    guard openpty(&master, &slave, nil, nil, nil) == 0 else { throw FixtureError.failed }
    defer { close(master); close(slave) }
    var original = termios()
    guard tcgetattr(slave, &original) == 0 else { throw FixtureError.failed }
    original.c_lflag |= tcflag_t(ECHO)
    guard tcsetattr(slave, TCSANOW, &original) == 0 else { throw FixtureError.failed }
    let child = Process(), output = Pipe()
    child.executableURL = URL(fileURLWithPath: "/usr/bin/swift")
    child.arguments = [helper, "import-smb", reference]
    child.standardInput = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
    child.standardError = FileHandle(fileDescriptor: slave, closeOnDealloc: false)
    child.standardOutput = output
    child.environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": NSHomeDirectory()]
    try child.run()
    defer { if child.isRunning { child.terminate(); child.waitUntilExit() } }
    let deadline = Date().addingTimeInterval(20)
    var terminal = Data(), buffer = [UInt8](repeating: 0, count: 1024), seen = 0
    defer { terminal.resetBytes(in: 0..<terminal.count); _ = buffer.withUnsafeMutableBytes { memset($0.baseAddress!, 0, $0.count) } }
    let suffix = Data("(hidden): ".utf8)
    for entry in entries {
        while seen == terminal.count || !terminal.suffix(suffix.count).elementsEqual(suffix) {
            guard Date() < deadline, child.isRunning else { throw FixtureError.failed }
            var descriptor = pollfd(fd: master, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 500)
            guard ready >= 0 else { throw FixtureError.failed }
            if ready == 0 { continue }
            let count = read(master, &buffer, buffer.count)
            guard count > 0, terminal.count + count < 8192 else { throw FixtureError.failed }
            terminal.append(contentsOf: buffer.prefix(count))
        }
        var current = termios()
        guard tcgetattr(slave, &current) == 0, current.c_lflag & tcflag_t(ECHO | ECHONL) == 0 else {
            throw FixtureError.failed
        }
        seen = terminal.count
        var line = entry; line.append(10)
        let written = line.withUnsafeBytes { write(master, $0.baseAddress!, $0.count) }
        line.resetBytes(in: 0..<line.count)
        guard written == entry.count + 1 else { throw FixtureError.failed }
    }
    while child.isRunning {
        guard Date() < deadline else { throw FixtureError.failed }
        var descriptor = pollfd(fd: master, events: Int16(POLLIN), revents: 0)
        if poll(&descriptor, 1, 100) > 0 {
            let count = read(master, &buffer, buffer.count)
            if count > 0 { terminal.append(contentsOf: buffer.prefix(count)) }
        }
    }
    child.waitUntilExit()
    guard child.terminationStatus == (success ? 0 : 1), terminal.count < 8192,
          entries.allSatisfy({ terminal.range(of: $0) == nil }) else { throw FixtureError.failed }
    var restored = termios()
    guard tcgetattr(slave, &restored) == 0, restored.c_lflag == original.c_lflag else { throw FixtureError.failed }
    let stdout = output.fileHandleForReading.readDataToEndOfFile()
    if success {
        guard stdout == Data("{\"smbRecovery\":\"created\"}\n".utf8), try readItem(reference) == entries[0] else {
            throw FixtureError.failed
        }
    } else {
        guard stdout.isEmpty, try readItem(reference) == nil else { throw FixtureError.failed }
    }
}
do {
    let args = Array(CommandLine.arguments.dropFirst())
    guard args.count == 1, args[0].hasPrefix("/"), FileManager.default.fileExists(atPath: args[0]) else {
        throw FixtureError.failed
    }
    let fixture = Data("disposable-terminal-fixture-password".utf8)
    try check(args[0], [fixture, fixture], true)
    try check(args[0], [fixture, Data("different-disposable-fixture-password".utf8)], false)
    try check(args[0], [Data(repeating: 65, count: 65)], false)
    print("{\"privateEntryFixture\":\"passed\",\"cases\":3,\"echoDisabled\":true,\"terminalRestored\":true,\"mismatchAndOversizeDenied\":true,\"secretOutput\":false}")
} catch {
    FileHandle.standardError.write(Data("{\"code\":\"backup_keychain_fixture_failed\"}\n".utf8))
    exit(1)
}
