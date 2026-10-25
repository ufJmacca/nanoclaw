import { test } from 'node:test';
import { runMailNativeFixture } from './mail-native-flow-fixture.js';
test(
  'G05 native reply drafts reconcile across restart, preserve the main context, and enforce the independent Sydney-day cap without model calls or sends',
  { timeout: 180000 },
  () => runMailNativeFixture(true),
);
