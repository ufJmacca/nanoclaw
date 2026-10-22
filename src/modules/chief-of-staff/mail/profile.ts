/** Fixed host profiles only. Existing reader identities and bytes keep their original contracts. */
export const mailProfiles = {
  mail_reader: {
    directory: 'mail-reader',
    marker: '.cos-mail-reader',
    contract: 'cos-mail-reader-root/v1',
    setupContract: 'cos-mail-profile-setup/v1',
    directoriesContract: 'cos-mail-profile-setup-directories/v1',
  },
  mail_draft_writer: {
    directory: 'mail-draft-writer',
    marker: '.cos-mail-draft-writer',
    contract: 'cos-mail-draft-writer-root/v1',
    setupContract: 'cos-mail-draft-profile-setup/v1',
    directoriesContract: 'cos-mail-draft-profile-setup-directories/v1',
  },
} as const;
export type MailCredentialProfile = keyof typeof mailProfiles;
export function mailProfile(profile: MailCredentialProfile) {
  if (profile !== 'mail_reader' && profile !== 'mail_draft_writer') throw Error('unsafe_mail_profile');
  return mailProfiles[profile];
}
