import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../types.js';
import { createSubscriptionAuthStore } from './codex-subscription-auth.js';
import { createSubscriptionNativeCheck } from './codex-subscription-runner.js';
import { createSubscriptionCoordinator, installSubscriptionCoordinator } from './codex-subscription-coordinator.js';

function privateDirectory(directory: string) {
  const stat = fs.lstatSync(directory);
  if (
    fs.realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('unsafe_subscription_runtime');
}
export function startHostSubscriptionCredentials(options: {
  root: string;
  home: string;
  model: string;
  image(): Promise<string>;
  assertAuthority(): void;
  authorizeSession(session: Session): Promise<boolean>;
}) {
  options.assertAuthority();
  privateDirectory(options.root);
  const stateDirectory = path.join(options.root, 'codex-auth');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  privateDirectory(stateDirectory);
  const socketRoot = path.join(stateDirectory, 'sessions');
  fs.mkdirSync(socketRoot, { recursive: true, mode: 0o700 });
  privateDirectory(socketRoot);
  let closed = false;
  const assertAuthority = () => {
    if (closed) throw new Error('subscription_owner_closed');
    options.assertAuthority();
  };
  const store = createSubscriptionAuthStore({
    sourceFile: path.join(options.home, '.codex', 'auth.json'),
    stateDirectory,
    assertAuthority,
    nativeCheck: createSubscriptionNativeCheck({ image: options.image, model: options.model, assertAuthority }),
  });
  // Cached shape/permissions only. This does not claim live authentication or model availability.
  store.cached();
  const coordinator = createSubscriptionCoordinator({
    root: socketRoot,
    store,
    assertAuthority,
    authorizeSession: options.authorizeSession,
  });
  const close = coordinator.close;
  coordinator.close = async () => {
    closed = true;
    await close();
  };
  const uninstall = installSubscriptionCoordinator(coordinator);
  return { coordinator, uninstall };
}
