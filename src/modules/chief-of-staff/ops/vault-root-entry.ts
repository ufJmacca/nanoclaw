import { runVaultRootGateway } from './vault-root-gateway.js';
try {
  // A fixed installed command consumes one private request. No flags, profiles, commands or resource paths are accepted.
  if (process.argv.length !== 2 || process.stdin.isTTY) throw Error('invalid_root_invocation');
  const result = await runVaultRootGateway(process.stdin);
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('{"code":"vault_root_gateway_unavailable"}\n');
  process.exitCode = 1;
}
