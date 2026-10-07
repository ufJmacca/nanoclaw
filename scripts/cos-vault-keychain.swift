// Trusted Mac credential helper. No key is accepted on argv or printed by inspection.
// `stream` writes binary material only to a private pipe feeding a checked admin operation.
import Foundation
import Security

enum VaultKeyError: Error { case invalidArguments, unavailable, invalidMaterial }
let keychainService = "nanoclaw-cos-vault-recovery/v1"
func query(_ reference: String) -> [String: Any] {
    return [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: reference]
}
func retrieve(_ reference: String) throws -> Data? {
    var request = query(reference)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let material = result as? Data else { throw VaultKeyError.unavailable }
    guard material.count == 64 else { throw VaultKeyError.invalidMaterial }
    return material
}
func erase(_ material: inout Data) {
    material.withUnsafeMutableBytes { buffer in
        if let address = buffer.baseAddress { memset(address, 0, buffer.count) }
    }
}
func ensure(_ reference: String) throws -> Bool {
    if var existing = try retrieve(reference) {
        erase(&existing)
        return false
    }
    var material = Data(count: 64)
    defer { erase(&material) }
    let randomStatus = material.withUnsafeMutableBytes { buffer in
        SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
    }
    guard randomStatus == errSecSuccess else { throw VaultKeyError.unavailable }
    var request = query(reference)
    request[kSecValueData as String] = material
    request[kSecAttrLabel as String] = "NanoClaw CoS vault recovery"
    let status = SecItemAdd(request as CFDictionary, nil)
    if status == errSecDuplicateItem {
        guard var existing = try retrieve(reference) else { throw VaultKeyError.unavailable }
        erase(&existing)
        return false
    }
    guard status == errSecSuccess else { throw VaultKeyError.unavailable }
    return true
}
do {
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["self-test"] || args == ["fixture-stream"] {
        let reference = "fixture-" + UUID().uuidString.lowercased()
        var created = false
        defer { if created { SecItemDelete(query(reference) as CFDictionary) } }
        created = try ensure(reference)
        guard created, var original = try retrieve(reference), try ensure(reference) == false,
              var replay = try retrieve(reference), original == replay else { throw VaultKeyError.unavailable }
        defer { erase(&original); erase(&replay) }
        if args == ["fixture-stream"] {
            guard isatty(STDOUT_FILENO) == 0 else { throw VaultKeyError.invalidArguments }
            FileHandle.standardOutput.write(replay)
        } else {
            print("{\"keychainFixture\":\"passed\",\"stableReplay\":true,\"secretOutput\":false}")
        }
    } else {
        guard args.count == 2, ["ensure", "check", "stream"].contains(args[0]),
              let reference = UUID(uuidString: args[1]), reference.uuidString.lowercased() == args[1] else {
            throw VaultKeyError.invalidArguments
        }
        if args[0] == "ensure" {
            let created = try ensure(args[1])
            print(created ? "{\"recoveryKey\":\"created\"}" : "{\"recoveryKey\":\"present\"}")
        } else {
            guard var material = try retrieve(args[1]) else { throw VaultKeyError.unavailable }
            defer { erase(&material) }
            if args[0] == "stream" {
                guard isatty(STDOUT_FILENO) == 0 else { throw VaultKeyError.invalidArguments }
                FileHandle.standardOutput.write(material)
            }
            else { print("{\"recoveryKey\":\"present\"}") }
        }
    }
} catch {
    FileHandle.standardError.write(Data("{\"code\":\"vault_keychain_unavailable\"}\n".utf8))
    exit(1)
}
