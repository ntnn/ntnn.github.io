import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SEARCH_LENGTH,
  filterEntries,
  filterOptions,
} from '../../static/tools/github-issue-pr-view/filter.mjs';

function entry({ id = 1, repository = 'owner/repo', ...overrides } = {}) {
  return {
    id,
    type: 'pr',
    repository,
    number: id,
    title: 'Add feature',
    author: 'author',
    url: `https://github.com/${repository}/pull/${id}`,
    updatedAt: 0,
    ...overrides,
  };
}

const ENTRIES = Object.freeze([
  entry({ id: 1, repository: 'kcp-dev/kcp', author: 'zoe', title: 'Fix shard routing' }),
  entry({ id: 2, repository: 'platform-mesh/operator', author: 'renovate[bot]', title: 'Update dependency foo to v2' }),
  entry({ id: 3, repository: 'kcp-dev/kcp', author: 'Adam', title: 'Add FEATURE gate', type: 'issue' }),
  entry({ id: 4, repository: 'kcp-dev/multicluster-provider', author: null, title: 'Document provider setup' }),
  entry({ id: 5, repository: 'platform-mesh/operator', author: 'zoe', title: 'Fix feature flag parsing' }),
  entry({ id: 6, repository: 'other/repo', author: 'renovate[bot]', title: 'Update dependency bar to v3' }),
]);

function ids(entries) {
  return entries.map(item => item.id);
}

test('filterOptions: count groups, repositories, and authors', () => {
  assert.deepEqual(filterOptions(ENTRIES), {
    groups: [
      { value: 'kcp-dev', count: 3 },
      { value: 'other', count: 1 },
      { value: 'platform-mesh', count: 2 },
    ],
    repositories: [
      { value: 'kcp-dev/kcp', count: 2 },
      { value: 'kcp-dev/multicluster-provider', count: 1 },
      { value: 'other/repo', count: 1 },
      { value: 'platform-mesh/operator', count: 2 },
    ],
    authors: [
      { value: 'renovate[bot]', count: 2 },
      { value: 'Adam', count: 1 },
      { value: 'zoe', count: 2 },
      { value: null, count: 1 },
    ],
  });
});

test('filterOptions: no entries yield no options', () => {
  assert.deepEqual(filterOptions([]), { groups: [], repositories: [], authors: [] });
});

test('filterOptions: pin every renovate and dependabot login before other authors', () => {
  const authors = [
    'bob', 'self-hosted-Renovate', 'alice', 'renovate[bot]', null, 'aaron', 'RENOVATE-bot', 'dependabot[bot]', 'Dependabot-preview',
  ];
  const options = filterOptions(authors.map((author, index) => entry({ id: index + 1, author })));
  assert.deepEqual(options.authors.map(option => option.value), [
    'Dependabot-preview',
    'dependabot[bot]',
    'RENOVATE-bot',
    'renovate[bot]',
    'self-hosted-Renovate',
    'aaron',
    'alice',
    'bob',
    null,
  ]);
});

test('filterOptions: sort authors case-insensitively', () => {
  const options = filterOptions(['bob', 'Carl', 'alice', 'Dave'].map((author, index) => entry({ id: index + 1, author })));
  assert.deepEqual(options.authors.map(option => option.value), ['alice', 'bob', 'Carl', 'Dave']);
});

for (const selection of [undefined, {}, { text: '' }, { text: '   ' }]) {
  test(`filterEntries: omitted selection ${JSON.stringify(selection)} restricts nothing`, () => {
    assert.deepEqual(filterEntries(ENTRIES, selection), ENTRIES);
  });
}

test('filterEntries: selecting every option restricts nothing', () => {
  const options = filterOptions(ENTRIES);
  const selection = {
    groups: options.groups.map(option => option.value),
    repositories: options.repositories.map(option => option.value),
    authors: options.authors.map(option => option.value),
  };
  assert.deepEqual(filterEntries(ENTRIES, selection), ENTRIES);
});

for (const selection of [{ groups: [] }, { repositories: [] }, { authors: [] }, { groups: new Set() }]) {
  test(`filterEntries: empty list in ${JSON.stringify(Object.keys(selection))} matches nothing`, () => {
    assert.deepEqual(filterEntries(ENTRIES, selection), []);
  });
}

test('filterEntries: accept sets as selections', () => {
  assert.deepEqual(ids(filterEntries(ENTRIES, { authors: new Set(['zoe', null]) })), [1, 4, 5]);
});

for (const { name, selection, expected } of [
  { name: 'one group', selection: { groups: ['kcp-dev'] }, expected: [1, 3, 4] },
  { name: 'several groups are alternatives', selection: { groups: ['other', 'platform-mesh'] }, expected: [2, 5, 6] },
  { name: 'one repository', selection: { repositories: ['kcp-dev/kcp'] }, expected: [1, 3] },
  {
    name: 'several repositories are alternatives',
    selection: { repositories: ['kcp-dev/multicluster-provider', 'other/repo'] },
    expected: [4, 6],
  },
  { name: 'one author', selection: { authors: ['zoe'] }, expected: [1, 5] },
  { name: 'deleted users', selection: { authors: [null] }, expected: [4] },
  { name: 'several authors are alternatives', selection: { authors: ['Adam', null, 'renovate[bot]'] }, expected: [2, 3, 4, 6] },
  { name: 'unknown values match nothing', selection: { groups: ['missing'] }, expected: [] },
  { name: 'group prefix does not match', selection: { groups: ['kcp'] }, expected: [] },
  { name: 'author match is exact', selection: { authors: ['adam'] }, expected: [] },
  { name: 'group and author must both match', selection: { groups: ['kcp-dev'], authors: ['zoe'] }, expected: [1] },
  {
    name: 'group and repository must both match',
    selection: { groups: ['kcp-dev'], repositories: ['platform-mesh/operator'] },
    expected: [],
  },
  {
    name: 'all dimensions combine',
    selection: { groups: ['platform-mesh'], repositories: ['platform-mesh/operator'], authors: ['zoe'], text: 'flag' },
    expected: [5],
  },
  { name: 'title search ignores case', selection: { text: 'feature' }, expected: [3, 5] },
  { name: 'title search ignores surrounding whitespace', selection: { text: '  FIX  ' }, expected: [1, 5] },
  { name: 'title search keeps inner whitespace', selection: { text: 'dependency foo' }, expected: [2] },
  { name: 'title search does not match authors', selection: { text: 'renovate' }, expected: [] },
  { name: 'title search does not match repositories', selection: { text: 'kcp' }, expected: [] },
  { name: 'title search treats pattern characters literally', selection: { text: '.*' }, expected: [] },
  { name: 'title search combines with authors', selection: { authors: ['renovate[bot]'], text: 'v3' }, expected: [6] },
]) {
  test(`filterEntries: ${name}`, () => {
    assert.deepEqual(ids(filterEntries(ENTRIES, selection)), expected);
  });
}

test('filterEntries: keep entry order and leave input untouched', () => {
  const entries = [ENTRIES[4], ENTRIES[0], ENTRIES[2]];
  const result = filterEntries(entries, { authors: ['zoe'] });
  assert.deepEqual(ids(result), [5, 1]);
  assert.deepEqual(ids(entries), [5, 1, 3]);
  assert.notEqual(result, entries);
});

test('filterEntries: accept search-length boundary and reject overflow', () => {
  const text = 'x'.repeat(MAX_SEARCH_LENGTH);
  assert.deepEqual(filterEntries(ENTRIES, { text }), []);
  assert.throws(() => filterEntries(ENTRIES, { text: `${text}x` }), RangeError);
});

for (const text of [null, 1, {}, ['fix']]) {
  test(`filterEntries: reject non-string search ${JSON.stringify(text)}`, () => {
    assert.throws(() => filterEntries(ENTRIES, { text }), TypeError);
  });
}
