import { REQUIRED_RELEASE_CHECKS, type ReleaseManifest } from '../../modules/chief-of-staff/ops/release-manifest.js';
import { INITIAL_CHECKSUM } from '../../modules/chief-of-staff/store/migrations.js';
import { KNOWLEDGE_CHECKSUM } from '../../modules/chief-of-staff/store/knowledge-schema.js';
import { CALENDAR_CHECKSUM } from '../../modules/chief-of-staff/store/calendar-schema.js';
import { WORK_CHECKSUM } from '../../modules/chief-of-staff/store/work-schema.js';
import { SCHEDULE_CHECKSUM } from '../../modules/chief-of-staff/store/schedule-schema.js';
import { BRIEF_CHECKSUM } from '../../modules/chief-of-staff/store/brief-schema.js';
import { MISSION_CHECKSUM } from '../../modules/chief-of-staff/store/mission-schema.js';
import { MISSION_RESULT_CHECKSUM } from '../../modules/chief-of-staff/store/mission-result-schema.js';
import { MISSION_REVIEW_CHECKSUM } from '../../modules/chief-of-staff/store/mission-review-schema.js';
import { TEAM_CHECKSUM } from '../../modules/chief-of-staff/store/team-schema.js';
import { TEAM_LINEAGE_CHECKSUM } from '../../modules/chief-of-staff/store/team-lineage-schema.js';
import { TEAM_FINAL_REVIEW_CHECKSUM } from '../../modules/chief-of-staff/store/team-final-review-schema.js';
import { TEAM_PARENT_BUDGET_CHECKSUM } from '../../modules/chief-of-staff/store/team-parent-budget-schema.js';
import { PROACTIVE_CHECKSUM } from '../../modules/chief-of-staff/store/proactive-schema.js';
import { MANDATE_CHECKSUM } from '../../modules/chief-of-staff/store/mandate-schema.js';
import { ACTION_CHECKSUM } from '../../modules/chief-of-staff/store/action-schema.js';
import { STRATEGY_CHECKSUM } from '../../modules/chief-of-staff/store/strategy-schema.js';
/** Synthetic identities for release-contract tests; never a transferable artifact receipt. */
export function fixtureRelease(slice: ReleaseManifest['slice'] = 'S01'): ReleaseManifest {
  const commit = 'a'.repeat(40),
    imageIds = ['sha256:' + 'c'.repeat(64), 'sha256:' + 'd'.repeat(64)],
    schemaVersion =
      slice === 'S01'
        ? 1
        : slice === 'S02'
          ? 2
          : slice === 'S03'
            ? 3
            : slice === 'S04'
              ? 6
              : slice === 'S05'
                ? 9
                : slice === 'S06'
                  ? 13
                  : slice === 'S07'
                    ? 14
                    : slice === 'S08'
                      ? 15
                      : slice === 'S09'
                        ? 16
                        : 17;
  return {
    contract: 'cos-release/v1',
    releaseId: 'release-fixture',
    slice,
    platform: 'linux/arm64',
    source: {
      repository: 'ufJmacca/nanoclaw',
      commit,
      tree: 'b'.repeat(40),
      fetchRef:
        slice === 'S01'
          ? 'refs/heads/cos/s01-first-use-and-priorities'
          : slice === 'S02'
            ? 'refs/heads/cos/s02-grounded-knowledge'
            : slice === 'S03'
              ? 'refs/heads/cos/s03-calendar-awareness'
              : slice === 'S04'
                ? 'refs/heads/cos/s04-daily-brief-and-commitments'
                : slice === 'S05'
                  ? 'refs/heads/cos/s05-isolated-research-missions'
                  : slice === 'S06'
                    ? 'refs/heads/cos/s06-specialist-teams-and-review'
                    : slice === 'S07'
                      ? 'refs/heads/cos/s07-proactive-proposals'
                      : slice === 'S08'
                        ? 'refs/heads/cos/s08-standing-mandates'
                        : slice === 'S09'
                          ? 'refs/heads/codex/s09-approved-calendar-actions'
                          : 'refs/heads/codex/s10-strategic-reviews',
      syncContract: 'cos-source-sync/github-pinned-v1',
    },
    buildInputDigest: 'e'.repeat(64),
    hostPayloadDigest: 'f'.repeat(64),
    workerAssetsDigest: '1'.repeat(64),
    rpc: 'cos-rpc/v1',
    postgres: { minimum: schemaVersion, maximum: schemaVersion },
    sqlite: { minimum: 22, maximum: 22 },
    migrations: [
      { version: 1, checksum: INITIAL_CHECKSUM },
      ...(schemaVersion >= 2 ? [{ version: 2, checksum: KNOWLEDGE_CHECKSUM }] : []),
      ...(schemaVersion >= 3 ? [{ version: 3, checksum: CALENDAR_CHECKSUM }] : []),
      ...(schemaVersion >= 6
        ? [
            { version: 4, checksum: WORK_CHECKSUM },
            { version: 5, checksum: SCHEDULE_CHECKSUM },
            { version: 6, checksum: BRIEF_CHECKSUM },
          ]
        : []),
      ...(schemaVersion >= 9
        ? [
            { version: 7, checksum: MISSION_CHECKSUM },
            { version: 8, checksum: MISSION_RESULT_CHECKSUM },
            { version: 9, checksum: MISSION_REVIEW_CHECKSUM },
          ]
        : []),
      ...(schemaVersion >= 13
        ? [
            { version: 10, checksum: TEAM_CHECKSUM },
            { version: 11, checksum: TEAM_LINEAGE_CHECKSUM },
            { version: 12, checksum: TEAM_FINAL_REVIEW_CHECKSUM },
            { version: 13, checksum: TEAM_PARENT_BUDGET_CHECKSUM },
          ]
        : []),
      ...(schemaVersion >= 14 ? [{ version: 14, checksum: PROACTIVE_CHECKSUM }] : []),
      ...(schemaVersion >= 15 ? [{ version: 15, checksum: MANDATE_CHECKSUM }] : []),
      ...(schemaVersion >= 16 ? [{ version: 16, checksum: ACTION_CHECKSUM }] : []),
      ...(schemaVersion >= 17 ? [{ version: 17, checksum: STRATEGY_CHECKSUM }] : []),
    ],
    previousReleaseIds: [],
    images: [
      {
        role: 'host',
        profile: 'host',
        tag: 'nanoclaw-cos-host:fixture',
        id: imageIds[0],
        configurationId: 'sha256:' + '2'.repeat(64),
      },
      {
        role: 'agent',
        profile: 'codex',
        tag: 'nanoclaw-cos-agent:fixture',
        id: imageIds[1],
        configurationId: 'sha256:' + '3'.repeat(64),
      },
    ],
    checks: Object.fromEntries(
      REQUIRED_RELEASE_CHECKS.map((check) => [
        check,
        {
          status: 'passed',
          at: '2026-09-29T12:00:00Z',
          sourceCommit: commit,
          imageIds: check.includes('image') ? imageIds : [],
        },
      ]),
    ),
  };
}
