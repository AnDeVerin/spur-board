// Commit CHANGELOG.md to main on each release only when the repository variable is 'true'.
// It needs a push identity that bypasses the main rulesets (#867); see CONTRIBUTING.md.
const commitChangelog = process.env.RELEASE_CHANGELOG_COMMIT === 'true';

// The header of CHANGELOG.md; @semantic-release/changelog writes new notes right below it.
const changelogTitle =
  '# Changelog\n\nNotable changes in each spur-board release, newest first. A breaking change lists what changed and how to migrate the config under **BREAKING CHANGES**; the versioning policy is in [CONTRIBUTING.md](CONTRIBUTING.md#versions-and-the-changelog). Releases before this file, and any release not listed here, are on the [GitHub releases page](https://github.com/AnDeVerin/spur-board/releases).';

// Shared by the analyzer and the notes generator. No fieldPattern: the default one reads a
// `- ... -` line in a PR body as a field and swallows the rest of the body, footer included.
// Only an uppercase `BREAKING CHANGE: ` starts a note, so a wrapped `breaking-change` line
// in an ordinary body is not one.
const parserOpts = {
  fieldPattern: null,
  notesPattern: (/** @type {string} */ keywords) => new RegExp(`^(${keywords}): (.*)`),
};

/**
 * @typedef {{ action: string | null }} Reference
 * @typedef {{ commits: Array<{ references: Reference[] }> }} CommitGroup
 */

/**
 * Lists only references made with a closing keyword; any other `#N` in a PR body is not a
 * closed issue.
 * @template {{ commitGroups: CommitGroup[] }} Context
 * @param {Context} context
 * @returns {Context}
 */
function keepActionReferences(context) {
  return {
    ...context,
    commitGroups: context.commitGroups.map((group) => ({
      ...group,
      commits: group.commits.map((commit) => ({
        ...commit,
        references: commit.references.filter((reference) => reference.action),
      })),
    })),
  };
}

module.exports = {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    [
      require.resolve('./scripts/release-analyzer.ts'),
      {
        preset: 'conventionalcommits',
        parserOpts,
        releaseRules: [
          { breaking: true, release: 'major' },
          { type: 'feat', release: 'minor' },
          { type: 'fix', release: 'patch' },
          { type: 'perf', release: 'patch' },
        ],
      },
    ],
    [
      require.resolve('@semantic-release/release-notes-generator'),
      {
        preset: 'conventionalcommits',
        parserOpts,
        writerOpts: { finalizeContext: keepActionReferences },
      },
    ],
    [require.resolve('@semantic-release/changelog'), { changelogFile: 'RELEASE_CHANGELOG.md' }],
    ...(commitChangelog
      ? [
          [
            require.resolve('@semantic-release/changelog'),
            { changelogFile: 'CHANGELOG.md', changelogTitle },
          ],
        ]
      : []),
    [require.resolve('@semantic-release/npm'), { pkgRoot: 'packages/cli', npmPublish: false }],
    require.resolve('./scripts/release-package.ts'),
    ...(commitChangelog
      ? [
          [
            require.resolve('@semantic-release/git'),
            {
              assets: ['CHANGELOG.md'],
              message: 'chore(release): ${nextRelease.version} [skip ci]',
            },
          ],
        ]
      : []),
    [require.resolve('@semantic-release/github'), { assets: ['RELEASE_CHANGELOG.md'] }],
  ],
};
