// Mac credential boundary: only owner-entered SMB material and independently
// generated repository material are stored here. No secret is accepted on argv.
// `stream` is reserved for a private pipe to the verified vault administration helper.
import Foundation
import Security
import Darwin

enum BackupKeychainError: Error { case invalidArguments, unavailable, invalidMaterial }
enum BackupSecret: String { case smb, restic }

func query(_ reference: String, _ kind: BackupSecret) -> [String: Any] {
    return [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "nanoclaw-cos-backup-" + kind.rawValue + "/v1",
            kSecAttrAccount as String: reference,
            kSecAttrSynchronizable as String: false]
}
func erase(_ material: inout Data) {
    material.withUnsafeMutableBytes { buffer in
        if let address = buffer.baseAddress { memset(address, 0, buffer.count) }
    }
}
func valid(_ material: Data, _ kind: BackupSecret) -> Bool {
    if kind == .restic {
        return material.count == 64 && material.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    return (16...64).contains(material.count)
        && !material.contains(where: { $0 == 0 || $0 == 10 || $0 == 13 })
        && String(data: material, encoding: .utf8) != nil
}
func retrieve(_ reference: String, _ kind: BackupSecret) throws -> Data? {
    var request = query(reference, kind)
    request[kSecReturnData as String] = true
    request[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, var material = result as? Data else { throw BackupKeychainError.unavailable }
    guard valid(material, kind) else { erase(&material); throw BackupKeychainError.invalidMaterial }
    return material
}
func add(_ reference: String, _ kind: BackupSecret, _ material: Data) throws {
    guard valid(material, kind) else { throw BackupKeychainError.invalidMaterial }
    var request = query(reference, kind)
    request[kSecValueData as String] = material
    request[kSecAttrLabel as String] = "NanoClaw CoS backup " + kind.rawValue
    guard SecItemAdd(request as CFDictionary, nil) == errSecSuccess else { throw BackupKeychainError.unavailable }
}
func ensureRestic(_ reference: String) throws -> Bool {
    // Do not create an orphan repository password before the dedicated account's
    // owner-entered recovery credential is available. Never overwrite an item.
    guard var smb = try retrieve(reference, .smb) else { throw BackupKeychainError.unavailable }
    defer { erase(&smb) }
    if var existing = try retrieve(reference, .restic) { erase(&existing); return false }
    var random = Data(count: 32), material = Data(count: 64)
    defer { erase(&random); erase(&material) }
    let status = random.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, $0.count, $0.baseAddress!) }
    guard status == errSecSuccess else { throw BackupKeychainError.unavailable }
    let digits: [UInt8] = Array("0123456789abcdef".utf8)
    for index in 0..<32 {
        material[index * 2] = digits[Int(random[index] >> 4)]
        material[index * 2 + 1] = digits[Int(random[index] & 15)]
    }
    try add(reference, .restic, material)
    return true
}
func inspect(_ reference: String) throws {
    guard var smb = try retrieve(reference, .smb) else { throw BackupKeychainError.unavailable }
    defer { erase(&smb) }
    guard var restic = try retrieve(reference, .restic) else { throw BackupKeychainError.unavailable }
    erase(&restic)
}
func writeBundle(_ reference: String, _ write: (Data) -> Void) throws {
    // The receiving helper requires this framing, exact bounds and no trailing data.
    guard var smb = try retrieve(reference, .smb) else { throw BackupKeychainError.unavailable }
    defer { erase(&smb) }
    guard var restic = try retrieve(reference, .restic) else { throw BackupKeychainError.unavailable }
    defer { erase(&restic) }
    write(Data([0x43, 0x4f, 0x53, 0x42, 1, UInt8(smb.count), UInt8(restic.count)]))
    write(smb)
    write(restic)
}
func stream(_ reference: String) throws {
    guard isatty(STDOUT_FILENO) == 0 else { throw BackupKeychainError.invalidArguments }
    try writeBundle(reference) { FileHandle.standardOutput.write($0) }
}
func selfTest() throws {
    let reference = "fixture-" + UUID().uuidString.lowercased()
    var smbAdded = false, resticAdded = false
    defer {
        if resticAdded { SecItemDelete(query(reference, .restic) as CFDictionary) }
        if smbAdded { SecItemDelete(query(reference, .smb) as CFDictionary) }
    }
    let invalidSmb = [Data(), Data(repeating: 65, count: 15), Data(repeating: 65, count: 65),
                      Data("fixture-secret\n\r\0".utf8), Data(repeating: 255, count: 32)]
    guard invalidSmb.allSatisfy({ !valid($0, .smb) }),
          !valid(Data(repeating: 65, count: 64), .restic),
          !valid(Data(repeating: 97, count: 63), .restic) else { throw BackupKeychainError.unavailable }
    do { _ = try ensureRestic(reference); throw BackupKeychainError.invalidMaterial }
    catch BackupKeychainError.unavailable { }
    guard try retrieve(reference, .restic) == nil else { throw BackupKeychainError.unavailable }
    var fixture = Data("disposable-synthetic-smb-password".utf8)
    defer { erase(&fixture) }
    try add(reference, .smb, fixture); smbAdded = true
    guard try ensureRestic(reference) else { throw BackupKeychainError.unavailable }
    resticAdded = true
    guard var first = try retrieve(reference, .restic) else { throw BackupKeychainError.unavailable }
    defer { erase(&first) }
    guard try ensureRestic(reference) == false,
          var replay = try retrieve(reference, .restic) else { throw BackupKeychainError.unavailable }
    defer { erase(&replay) }
    guard first == replay, first.count == 64 else { throw BackupKeychainError.unavailable }
    try inspect(reference)
    var wire = Data()
    defer { erase(&wire) }
    try writeBundle(reference) { wire.append($0) }
    guard wire.prefix(7) == Data([0x43, 0x4f, 0x53, 0x42, 1, UInt8(fixture.count), 64]),
          wire.count == 7 + fixture.count + first.count,
          wire.subdata(in: 7..<(7 + fixture.count)) == fixture,
          wire.suffix(64) == first else { throw BackupKeychainError.unavailable }
    // Duplicate insertion must fail without replacing either independent item.
    do { try add(reference, .smb, Data(repeating: 66, count: 32)); throw BackupKeychainError.invalidMaterial }
    catch BackupKeychainError.unavailable { }
    guard var original = try retrieve(reference, .smb) else { throw BackupKeychainError.unavailable }
    defer { erase(&original) }
    guard original == fixture else { throw BackupKeychainError.unavailable }
    print("{\"backupKeychainFixture\":\"passed\",\"stableReplay\":true,\"missingSmbDenied\":true,\"duplicatePreserved\":true,\"invalidMaterialDenied\":true,\"secretOutput\":false}")
}
do {
    var core = rlimit(rlim_cur: 0, rlim_max: 0)
    guard setrlimit(RLIMIT_CORE, &core) == 0 else { throw BackupKeychainError.unavailable }
    let args = Array(CommandLine.arguments.dropFirst())
    if args == ["self-test"] { try selfTest() }
    else {
        guard args.count == 2, ["ensure-restic", "check", "stream"].contains(args[0]),
              let reference = UUID(uuidString: args[1]), reference.uuidString.lowercased() == args[1] else {
            throw BackupKeychainError.invalidArguments
        }
        if args[0] == "ensure-restic" {
            let created = try ensureRestic(args[1])
            print(created ? "{\"repositoryRecovery\":\"created\"}" : "{\"repositoryRecovery\":\"present\"}")
        } else if args[0] == "check" {
            try inspect(args[1]); print("{\"backupRecovery\":\"present\",\"secretOutput\":false}")
        } else { try stream(args[1]) }
    }
} catch {
    FileHandle.standardError.write(Data("{\"code\":\"backup_keychain_unavailable\"}\n".utf8))
    exit(1)
}
