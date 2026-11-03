import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_QUERY_LENGTH,
  MAX_SELECTORS,
  buildSearchScopes,
  isReadyTitle,
  matchesRepository,
  normalizeSelector,
  parseQuery,
  serializeQuery,
} from '../../themes/ntnn/assets/js/prs/query.mjs';

const EXAMPLE_QUERY = '?repos=platform-mesh/*,kcp-dev/*,kubernetes-sigs/multicluster-runtime&exclude=platform-mesh/portal';

for (const { name, search, expected } of [
  {
    name: 'supplied example',
    search: EXAMPLE_QUERY,
    expected: {
      repos: ['platform-mesh/*', 'kcp-dev/*', 'kubernetes-sigs/multicluster-runtime'],
      exclude: ['platform-mesh/portal'],
    },
  },
  {
    name: 'repeated parameters and multiple exclusions',
    search: '?repos=platform-mesh/*&repos=kcp-dev/*,kubernetes-sigs/multicluster-runtime&exclude=platform-mesh/portal,kcp-dev/kcp&exclude=platform-mesh/dashboard',
    expected: {
      repos: ['platform-mesh/*', 'kcp-dev/*', 'kubernetes-sigs/multicluster-runtime'],
      exclude: ['platform-mesh/portal', 'kcp-dev/kcp', 'platform-mesh/dashboard'],
    },
  },
  {
    name: 'whitespace, casing, and duplicates',
    search: '?repos=+PLATFORM-MESH/*+,kcp-dev/*&repos=platform-mesh/*&exclude=+Platform-Mesh/Portal+,platform-mesh/portal',
    expected: { repos: ['platform-mesh/*', 'kcp-dev/*'], exclude: ['platform-mesh/portal'] },
  },
  {
    name: 'wildcards cover exact includes regardless of order',
    search: '?repos=platform-mesh/portal,kcp-dev/*,platform-mesh/*,kcp-dev/kcp,other/repo',
    expected: { repos: ['kcp-dev/*', 'platform-mesh/*', 'other/repo'], exclude: [] },
  },
  {
    name: 'explicit include/exclude conflict remains serializable',
    search: '?repos=platform-mesh/portal&exclude=platform-mesh/portal',
    expected: { repos: ['platform-mesh/portal'], exclude: ['platform-mesh/portal'] },
  },
  {
    name: 'URL-encoded separators',
    search: '?repos=platform-mesh%2F*%2Ckcp-dev%2F*&exclude=platform-mesh%2Fportal',
    expected: { repos: ['platform-mesh/*', 'kcp-dev/*'], exclude: ['platform-mesh/portal'] },
  },
  {
    name: 'exact repository duplicates',
    search: '?repos=owner/repo,OWNER/REPO&repos=owner/repo',
    expected: { repos: ['owner/repo'], exclude: [] },
  },
  {
    name: 'unrelated parameters do not become selectors',
    search: '?theme=light&org=other&repos=owner/repo',
    expected: { repos: ['owner/repo'], exclude: [] },
  },
  {
    name: 'exclusions do not imply includes',
    search: '?exclude=platform-mesh/portal',
    expected: { repos: [], exclude: ['platform-mesh/portal'] },
  },
]) {
  test(`parseQuery: ${name}`, () => {
    assert.deepEqual(parseQuery(search), expected);
  });
}

for (const search of ['', '?', '?repos', '?repos=&exclude=', '?repos=+%20&repos=&exclude=+', '?theme=light']) {
  test(`parseQuery: empty selectors in ${JSON.stringify(search)}`, () => {
    const query = parseQuery(search);
    assert.deepEqual(query, { repos: [], exclude: [] });
    assert.deepEqual(buildSearchScopes(query), []);
    assert.equal(matchesRepository('owner/repo', query), false);
  });
}

test('parseQuery: omitted query is empty', () => {
  assert.deepEqual(parseQuery(), { repos: [], exclude: [] });
});

for (const search of [
  '?repos=owner/repo,',
  '?repos=,owner/repo',
  '?repos=owner/repo,,other/repo',
  '?repos=,',
  '?exclude=owner/repo,',
  '?repos=owner/*&exclude=owner/*',
  '?repos=owner/repo&repos=invalid',
  '?repos=owner/repo&exclude=invalid',
  '?repos=owner%2Frepo%20is%3Aclosed',
  '?repos=owner%2Frepo%26repos%3Dother%2F*',
  '?repos=owner%2Frepo%00',
  '?repos=owner/%FF',
  '?repos=owner/%',
  '?repos=owner%252Frepo',
]) {
  test(`parseQuery: reject ${JSON.stringify(search)}`, () => {
    assert.throws(() => parseQuery(search), /Invalid selector/);
  });
}

for (const value of [null, 1, {}, [], new URLSearchParams('repos=owner/repo')]) {
  test(`parseQuery: reject non-string ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseQuery(value), TypeError);
  });
}

test('parseQuery: accept query-length boundary and reject overflow', () => {
  const prefix = '?repos=owner/repo&ignored=';
  const search = prefix + 'x'.repeat(MAX_QUERY_LENGTH - prefix.length);
  assert.deepEqual(parseQuery(search), { repos: ['owner/repo'], exclude: [] });
  assert.throws(() => parseQuery(`${search}x`), RangeError);
});

test('parseQuery: selector limit counts includes and excludes together', () => {
  const repos = Array.from({ length: MAX_SELECTORS - 1 }, (_, index) => `owner/repo-${index}`);
  const search = `?repos=${repos.join(',')}&exclude=owner/ignored`;
  assert.equal(parseQuery(search).repos.length, repos.length);
  assert.throws(() => parseQuery(`${search}&exclude=owner/another`), RangeError);
});

test('parseQuery: duplicate selectors cannot bypass selector limit', () => {
  const selectors = Array(MAX_SELECTORS).fill('owner/repo');
  const search = `?repos=${selectors.join(',')}`;
  assert.deepEqual(parseQuery(search), { repos: ['owner/repo'], exclude: [] });
  assert.throws(() => parseQuery(`${search}&repos=OWNER/REPO`), RangeError);
});

test('parseQuery: repeated parameters cannot bypass selector limit', () => {
  const params = new URLSearchParams();
  for (let index = 0; index < MAX_SELECTORS; index++) params.append('exclude', 'owner/repo');
  assert.deepEqual(parseQuery(params.toString()), { repos: [], exclude: ['owner/repo'] });
  params.append('exclude', 'owner/repo');
  assert.throws(() => parseQuery(params.toString()), RangeError);
});

for (const { value, allowWildcard, expected } of [
  { value: ' PLATFORM-MESH/Portal ', expected: 'platform-mesh/portal' },
  { value: 'kcp-dev/*', allowWildcard: true, expected: 'kcp-dev/*' },
  { value: 'owner/.github', expected: 'owner/.github' },
  { value: 'owner/repo_name.v2-rc', expected: 'owner/repo_name.v2-rc' },
  { value: 'a/b', expected: 'a/b' },
  { value: '123/456', expected: '123/456' },
]) {
  test(`normalizeSelector: accept ${JSON.stringify(value)}`, () => {
    assert.equal(normalizeSelector(value, { allowWildcard }), expected);
  });
}

for (const value of [
  '',
  'owner',
  '/repo',
  'owner/',
  'owner/repo/extra',
  'https://github.com/owner/repo',
  'org:owner',
  'owner/repo is:closed',
  'owner/repo OR repo:other/repo',
  'owner/repo\nrepo:other/repo',
  'owner/repo\u0000',
  'owner/repo?draft=true',
  'owner/repo#fragment',
  'owner/repo&repos=other/repo',
  'owner/repo,other/repo',
  'owner/repo%20',
  '*/repo',
  'owner*/repo',
  'owner/repo*',
  'owner/**',
  '-owner/repo',
  'owner-/repo',
  'own--er/repo',
  'own_er/repo',
  'owner/..',
  'owner/.',
  'owner/repo name',
  'owner\\repo',
  'öwner/repo',
  'owner/répo',
  'Kcp-dev/repo',
  'owner/Kernel',
]) {
  test(`normalizeSelector: reject ${JSON.stringify(value)}`, () => {
    assert.throws(() => normalizeSelector(value, { allowWildcard: true }), /Invalid selector/);
  });
}

test('normalizeSelector: wildcard requires explicit permission', () => {
  assert.throws(() => normalizeSelector('owner/*'), /Invalid selector/);
});

test('normalizeSelector: reject non-string values', () => {
  for (const value of [null, undefined, {}, [], 1]) {
    assert.throws(() => normalizeSelector(value), TypeError);
  }
});

test('normalizeSelector: enforce GitHub name-length limits', () => {
  const ownerLengthLimit = 39;
  const repositoryLengthLimit = 100;
  const owner = 'a'.repeat(ownerLengthLimit);
  const repository = 'b'.repeat(repositoryLengthLimit);
  assert.equal(normalizeSelector(`${owner}/${repository}`), `${owner}/${repository}`);
  assert.throws(() => normalizeSelector(`${owner}a/repo`), /Invalid selector/);
  assert.throws(() => normalizeSelector(`owner/${repository}b`), /Invalid selector/);
});

for (const { repository, expected } of [
  { repository: 'platform-mesh/operator', expected: true },
  { repository: 'PLATFORM-MESH/Operator', expected: true },
  { repository: 'platform-mesh/portal', expected: false },
  { repository: 'PLATFORM-MESH/PORTAL', expected: false },
  { repository: 'platform-mesh/portal-extra', expected: true },
  { repository: 'platform-mesh-extra/operator', expected: false },
  { repository: 'kcp-dev/kcp', expected: true },
  { repository: 'kubernetes-sigs/multicluster-runtime', expected: true },
  { repository: 'kubernetes-sigs/multicluster-runtime-extra', expected: false },
  { repository: 'other/portal', expected: false },
]) {
  test(`matchesRepository: ${repository}`, () => {
    assert.equal(matchesRepository(repository, parseQuery(EXAMPLE_QUERY)), expected);
  });
}

test('matchesRepository: exclusion wins over explicit and wildcard includes', () => {
  for (const repos of ['owner/repo', 'owner/*,owner/repo', 'owner/repo,owner/*']) {
    const query = parseQuery(`repos=${repos}&exclude=owner/repo,owner/another`);
    assert.equal(matchesRepository('owner/repo', query), false);
    assert.equal(matchesRepository('owner/another', query), false);
  }
});

test('matchesRepository: reject malformed repository names', () => {
  const query = parseQuery(EXAMPLE_QUERY);
  for (const repository of ['platform-mesh/*', 'platform-mesh/../portal', '', null]) {
    assert.throws(() => matchesRepository(repository, query));
  }
});

test('buildSearchScopes: emit normalized scope qualifiers', () => {
  assert.deepEqual(buildSearchScopes(parseQuery(EXAMPLE_QUERY)), [
    'org:platform-mesh',
    'org:kcp-dev',
    'repo:kubernetes-sigs/multicluster-runtime',
  ]);
});

test('buildSearchScopes: remove redundant and excluded exact scopes', () => {
  const query = parseQuery('?repos=owner/repo,owner/*,other/repo,third/repo&exclude=owner/repo,other/repo');
  assert.deepEqual(buildSearchScopes(query), ['org:owner', 'repo:third/repo']);
});

test('buildSearchScopes: no searches when all exact includes are excluded', () => {
  const query = parseQuery('?repos=owner/repo,other/repo&exclude=owner/repo,other/repo');
  assert.deepEqual(buildSearchScopes(query), []);
});

test('serializeQuery: round-trip normalized selectors with URLSearchParams', () => {
  const query = parseQuery('?repos=Owner/Repo,owner/*&repos=OTHER/Repo&exclude=Owner/Repo&exclude=other/ignored');
  const serialized = serializeQuery(query);
  const params = new URLSearchParams(serialized);
  assert.deepEqual(params.getAll('repos'), ['owner/*,other/repo']);
  assert.deepEqual(params.getAll('exclude'), ['owner/repo,other/ignored']);
  assert.deepEqual(parseQuery(serialized), query);
});

test('serializeQuery: omit empty parameters', () => {
  assert.equal(serializeQuery(parseQuery('')), '');
  assert.equal(new URLSearchParams(serializeQuery(parseQuery('repos=owner/repo'))).has('exclude'), false);
  assert.equal(new URLSearchParams(serializeQuery(parseQuery('exclude=owner/repo'))).has('repos'), false);
});

test('query consumers do not mutate parsed selectors', () => {
  const query = parseQuery(EXAMPLE_QUERY);
  Object.freeze(query.repos);
  Object.freeze(query.exclude);
  Object.freeze(query);
  buildSearchScopes(query);
  matchesRepository('kcp-dev/kcp', query);
  assert.deepEqual(parseQuery(serializeQuery(query)), query);
});

for (const title of [
  '[WIP] Add feature',
  'Add feature [wip]',
  'fix: [ WIP ] add feature',
  '(WIP) Add feature',
  'Add feature ( wIp )',
  '[work in progress] Add feature',
  'Add feature (work-in-progress)',
  'WORK IN PROGRESS: Add feature',
  'work-in-progress - Add feature',
  '[DRAFT] Add feature',
  'Add feature (draft)',
  'Draft: Add feature',
  'DRAFT Add feature',
  '[DNM] Add feature',
  'Add feature (dnm)',
  'DNM - Add feature',
  '[do not merge] Add feature',
  'Add feature (do-not-merge)',
  'DO-NOT-MERGE: Add feature',
  'do not merge Add feature',
  'WIP: Add feature',
  'WIP:Add feature',
  'WIP-Add feature',
  'WIP–Add feature',
  'WIP—Add feature',
  'WIP Add feature',
  '  wip\tAdd feature',
  'WIP',
  'work in progress',
  'draft',
  'DNM',
  'do not merge',
]) {
  test(`isReadyTitle: exclude ${JSON.stringify(title)}`, () => {
    assert.equal(isReadyTitle(title), false);
    assert.equal(isReadyTitle(title), false);
  });
}

for (const title of [
  'Add feature',
  'Fix swipe navigation',
  'Wipe obsolete data',
  'WIPES: clean buffers',
  'Add draft documentation',
  'Drafting guidelines',
  'Support work in progress tracking',
  'Document do not merge policy',
  'Update DNM handling',
  '[WIPES] Clean buffers',
  'Support (draft mode)',
  '[feature] Improve navigation',
  'Fix [WIP) parser example',
  'Fix (WIP] parser example',
]) {
  test(`isReadyTitle: include ${JSON.stringify(title)}`, () => {
    assert.equal(isReadyTitle(title), true);
  });
}

test('isReadyTitle: reject missing, empty, and non-string titles', () => {
  for (const title of ['', ' \t\n', null, undefined, 1, {}, ['Add feature']]) {
    assert.equal(isReadyTitle(title), false);
  }
});
