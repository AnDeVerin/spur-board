module.exports = {
  branches: ['main'],
  tagFormat: 'v${version}',
  plugins: [
    [
      require.resolve('@semantic-release/commit-analyzer'),
      {
        preset: 'conventionalcommits',
        releaseRules: [
          { breaking: true, release: 'minor' },
          { type: 'feat', release: 'minor' },
          { type: 'fix', release: 'patch' },
          { type: 'perf', release: 'patch' },
        ],
      },
    ],
    [
      require.resolve('@semantic-release/release-notes-generator'),
      { preset: 'conventionalcommits' },
    ],
    [require.resolve('@semantic-release/changelog'), { changelogFile: 'RELEASE_CHANGELOG.md' }],
    [require.resolve('@semantic-release/npm'), { pkgRoot: 'packages/cli', npmPublish: false }],
    require.resolve('./scripts/release-package.ts'),
    [require.resolve('@semantic-release/github'), { assets: ['RELEASE_CHANGELOG.md'] }],
  ],
};
