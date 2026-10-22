import { test } from 'node:test';
import { runMailNativeFixture } from './mail-native-flow-fixture.js';
test(
  'G04 native mail conversation cites only selected messages, preserves context across restart and closes withdrawn evidence',
  { timeout: 90000 },
  () => runMailNativeFixture(),
);
