import test from 'node:test';
import { runMailReviewNativeFixture } from './mail-native-flow-fixture.js';

test(
  'G06 both Sydney reviews use native routing, retained context, bounded drafts and checked private briefings',
  { timeout: 120000 },
  () => runMailReviewNativeFixture(),
);
