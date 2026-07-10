import fs from 'node:fs';

import { closeDb, initDb } from '../../db/index.js';
import { subscribeMattermostChannelStrict } from '../mattermost-subscription.js';

const [dbPath, instanceKey, channelId] = process.argv.slice(2);
if (!dbPath || !instanceKey || !channelId) {
  throw new Error('Expected database path, instance key, and channel id');
}

initDb(dbPath);
try {
  const result = subscribeMattermostChannelStrict({ instanceKey, channelId });
  fs.writeSync(
    1,
    `${JSON.stringify({
      messagingGroupId: result.messagingGroup.id,
      agentGroupId: result.agentGroup.id,
      wiringId: result.wiring.id,
    })}\n`,
  );
} finally {
  closeDb();
}
