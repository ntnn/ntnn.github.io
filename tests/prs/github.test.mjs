import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_RESPONSE_BYTES,
  MAX_SEARCH_RESULTS,
  MAX_TITLE_LENGTH,
  MAX_AUTHOR_LENGTH,
  RESULTS_PER_PAGE,
  REQUEST_TIMEOUT_MS,
  SEARCH_INTERVAL_MS,
  SEARCH_LIMITATIONS,
  createGitHubClient,
} from '../../themes/ntnn/assets/js/prs/github.mjs';

const START = Date.parse('2026-01-01T00:00:00Z');
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;

function pullRequest({ id = 1, number = id, repositoryName = 'owner/repo', ...overrides } = {}) {
  return {
    id,
    number,
    title: 'Add feature',
    state: 'open',
    draft: false,
    user: { login: 'author' },
    updated_at: '2026-01-01T00:00:00Z',
    repository_url: `https://api.github.com/repos/${repositoryName}`,
    html_url: `https://github.com/${repositoryName}/pull/${number}`,
    pull_request: { merged_at: null },
    ...overrides,
  };
}

function page(items = [], { total = items.length, incomplete = false, headers = {} } = {}) {
  return Response.json({ total_count: total, incomplete_results: incomplete, items }, { headers });
}

function fullPage(items, options = {}) {
  const padding = Array.from({ length: RESULTS_PER_PAGE - items.length }, (_, index) => pullRequest({
    id: MAX_SEARCH_RESULTS + index + 1,
    title: '[WIP] Filler',
  }));
  return page([...items, ...padding], { total: RESULTS_PER_PAGE + 1, ...options });
}

function fixture(responses, options = {}) {
  const pending = [...responses];
  const calls = [];
  const waits = [];
  let time = START;
  const client = createGitHubClient({
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), init, time });
      assert.ok(pending.length, 'Unexpected API request');
      const response = pending.shift();
      return typeof response === 'function' ? response(url, init) : response;
    },
    now: () => time,
    wait: async (milliseconds, signal) => {
      signal.throwIfAborted();
      waits.push(milliseconds);
      time += milliseconds;
    },
    timeoutSignal: () => new AbortController().signal,
    ...options,
  });
  return { client, calls, waits, advance: milliseconds => { time += milliseconds; } };
}

test('load: fetch selected scopes serially with mandatory qualifiers and no credentials', async () => {
  const older = pullRequest({ repositoryName: 'platform-mesh/operator', updated_at: '2025-12-01T00:00:00Z' });
  const newer = pullRequest({ id: 2, repositoryName: 'kcp-dev/kcp' });
  const last = pullRequest({ id: 3, repositoryName: 'kubernetes-sigs/multicluster-runtime', user: null });
  const { client, calls, waits } = fixture([page([older]), page([newer]), page([last])]);
  const progress = [];
  const result = await client.load('repos=platform-mesh/*,kcp-dev/*,kubernetes-sigs/multicluster-runtime&exclude=platform-mesh/portal', {
    onProgress: update => progress.push(update),
  });

  assert.equal(result.complete, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.requests, 3);
  assert.equal(result.pagesLoaded, 3);
  assert.deepEqual(result.pullRequests.map(pr => pr.id), [1, 2, 3]);
  assert.deepEqual(result.pullRequests[2], {
    id: 3,
    repository: 'kubernetes-sigs/multicluster-runtime',
    number: 3,
    title: 'Add feature',
    author: null,
    url: 'https://github.com/kubernetes-sigs/multicluster-runtime/pull/3',
    updatedAt: START,
  });
  assert.deepEqual(result.limitations, SEARCH_LIMITATIONS);
  assert.equal(result.retryAt, null);
  assert.deepEqual(waits, [SEARCH_INTERVAL_MS, SEARCH_INTERVAL_MS]);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('q')), [
    'is:pr is:open archived:false draft:false org:platform-mesh -repo:platform-mesh/portal',
    'is:pr is:open archived:false draft:false org:kcp-dev',
    'is:pr is:open archived:false draft:false repo:kubernetes-sigs/multicluster-runtime',
  ]);
  for (const { url, init } of calls) {
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/search/issues');
    assert.equal(url.searchParams.get('per_page'), String(RESULTS_PER_PAGE));
    assert.equal(url.searchParams.get('sort'), 'updated');
    assert.equal(url.searchParams.get('order'), 'asc');
    assert.equal(url.searchParams.get('page'), '1');
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Accept, 'application/vnd.github+json');
    assert.equal(init.headers.Authorization, undefined);
  }
  assert.equal(progress.at(-1).phase, 'loaded');
  assert.equal(progress.at(-1).count, 3);
  assert.equal(progress.at(-1).scopeCount, 3);
  assert.equal(progress.at(-1).completedScopes, 2);
});

test('load: sort oldest updates first across scopes and pages', async () => {
  const older = pullRequest({ id: 2 });
  const newer = pullRequest({ id: 1, updated_at: '2026-01-03T00:00:00Z' });
  const oldest = pullRequest({ id: 3, repositoryName: 'other/repo', updated_at: '2025-12-01T00:00:00Z' });
  const tied = pullRequest({ id: 4, repositoryName: 'other/repo' });
  const { client, calls } = fixture([
    fullPage([older]),
    page([newer], { total: RESULTS_PER_PAGE + 1 }),
    page([oldest, tied]),
  ]);
  const result = await client.load('repos=owner/*,other/repo');
  assert.equal(result.complete, true);
  assert.deepEqual(result.pullRequests.map(pr => pr.id), [3, 2, 4, 1]);
  for (const { url } of calls) {
    assert.equal(url.searchParams.get('sort'), 'updated');
    assert.equal(url.searchParams.get('order'), 'asc');
  }
});

for (const search of ['', 'exclude=owner/repo', 'repos=owner/repo&exclude=owner/repo']) {
  test(`load: skip empty or fully excluded scopes ${JSON.stringify(search)}`, async () => {
    const { client, calls } = fixture([]);
    const result = await client.load(search);
    assert.equal(result.complete, true);
    assert.deepEqual(result.pullRequests, []);
    assert.equal(calls.length, 0);
  });
}

test('load: validate input before requests', async () => {
  const { client, calls } = fixture([]);
  await assert.rejects(client.load('repos=owner/repo+is:closed'), /Invalid selector/);
  assert.equal(calls.length, 0);
});

test('load: remove duplicate and excluded explicit scopes', async () => {
  const { client, calls } = fixture([page()]);
  const result = await client.load('repos=OWNER/*,owner/repo,owner/*,other/repo&exclude=other/repo');
  assert.equal(result.complete, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('q'), 'is:pr is:open archived:false draft:false org:owner');
});

test('load: apply exclusions locally even when they do not fit GitHub query', async () => {
  const exclusions = Array.from({ length: 10 }, (_, index) => `owner/repository-with-long-name-${index}`);
  const items = exclusions.map((repositoryName, index) => pullRequest({ id: index + 1, repositoryName }));
  const { client, calls } = fixture([page([...items, pullRequest({ id: 11 })])]);
  const result = await client.load(`repos=owner/*&exclude=${exclusions.join(',')}`);
  const search = calls[0].url.searchParams.get('q');
  assert.ok(search.includes(`-repo:${exclusions[0]}`));
  assert.ok(!search.includes(`-repo:${exclusions.at(-1)}`));
  assert.deepEqual(result.pullRequests.map(pr => pr.id), [11]);
});

test('load: paginate after a fully filtered page and ignore foreign pagination links', async () => {
  const hidden = Array.from({ length: RESULTS_PER_PAGE }, (_, index) => pullRequest({ id: index + 1, title: '[WIP] Add feature' }));
  const { client, calls } = fixture([
    page(hidden, { total: RESULTS_PER_PAGE + 3, headers: { Link: '<https://evil.example/steal>; rel="next"' } }),
    page([
      pullRequest({ id: 101, repositoryName: 'owner/ignored' }),
      pullRequest({ id: 102, repositoryName: 'owner/also-ignored' }),
      pullRequest({ id: 103 }),
    ], { total: RESULTS_PER_PAGE + 3 }),
  ]);
  const result = await client.load('repos=owner/*&exclude=owner/ignored,owner/also-ignored');
  assert.deepEqual(result.pullRequests.map(pr => pr.id), [103]);
  assert.equal(result.complete, true);
  assert.deepEqual(calls.map(call => call.url.searchParams.get('page')), ['1', '2']);
  assert.ok(calls.every(call => call.url.origin === 'https://api.github.com'));
});

test('load: filter issues, closed PRs, drafts, WIP, archived repositories, and unrelated scopes', async () => {
  const { client } = fixture([page([
    pullRequest({ id: 1 }),
    pullRequest({ id: 2, pull_request: undefined, draft: undefined }),
    pullRequest({ id: 3, state: 'closed' }),
    pullRequest({ id: 4, draft: true }),
    pullRequest({ id: 5, title: '[DNM] Add feature' }),
    pullRequest({ id: 6, repository: { archived: true } }),
    pullRequest({ id: 7, repositoryName: 'unselected/repo' }),
    pullRequest({ id: 8, pull_request: { merged_at: '2026-01-01T00:00:00Z' } }),
    pullRequest({ id: 9, repository: { archived: false } }),
  ])]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.complete, true);
  assert.deepEqual(result.pullRequests.map(pr => pr.id), [1, 9]);
});

test('load: preserve title text without returning unused API fields', async () => {
  const title = '<img src=x onerror=alert(1)> Add feature';
  const { client } = fixture([page([pullRequest({ title, body: '<script>bad()</script>', repositoryName: 'OWNER/Repo' })])]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.pullRequests[0].title, title);
  assert.equal(result.pullRequests[0].repository, 'owner/repo');
  assert.equal(result.pullRequests[0].body, undefined);
  assert.equal(result.pullRequests[0].url, 'https://github.com/owner/repo/pull/1');
});

test('load: deduplicate by ID and prefer newest observed version', async () => {
  const newer = pullRequest({ title: 'New title' });
  const older = pullRequest({ title: 'Old title', updated_at: '2025-12-01T00:00:00Z' });
  const { client } = fixture([fullPage([newer]), page([older], { total: RESULTS_PER_PAGE + 1 })]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.pullRequests.length, 1);
  assert.equal(result.pullRequests[0].title, 'New title');
});

for (const overrides of [
  { draft: true },
  { state: 'closed' },
  { title: '[WIP] Changed title' },
  { repository: { archived: true } },
  { repositoryName: 'owner/excluded' },
]) {
  test(`load: newer ineligible observation removes previous result ${JSON.stringify(overrides)}`, async () => {
    const { client } = fixture([
      fullPage([pullRequest()]),
      page([pullRequest(overrides)], { total: RESULTS_PER_PAGE + 1 }),
    ]);
    const result = await client.load('repos=owner/*&exclude=owner/excluded');
    assert.equal(result.complete, true);
    assert.deepEqual(result.pullRequests, []);
  });
}

test('load: older ineligible observation cannot remove newer result', async () => {
  const { client } = fixture([
    fullPage([pullRequest()]),
    page([pullRequest({ draft: true, updated_at: '2025-12-01T00:00:00Z' })], { total: RESULTS_PER_PAGE + 1 }),
  ]);
  assert.equal((await client.load('repos=owner/*')).pullRequests.length, 1);
});

test('load: report incomplete results only once per scope', async () => {
  const { client } = fixture([
    fullPage([pullRequest()], { incomplete: true }),
    page([pullRequest({ id: 2 })], { total: RESULTS_PER_PAGE + 1, incomplete: true }),
  ]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.complete, false);
  assert.equal(result.pullRequests.length, 2);
  assert.deepEqual(result.problems.map(problem => problem.code), ['incomplete']);
});

test('load: short nonempty page is incomplete even when API claims otherwise', async () => {
  const { client } = fixture([page([pullRequest()], { total: 2 })]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.complete, false);
  assert.equal(result.pullRequests.length, 1);
  assert.equal(result.problems[0].code, 'incomplete');
});

test('load: unexpected empty page is incomplete, not an endless pagination loop', async () => {
  const { client, calls } = fixture([page([], { total: 1 })]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.complete, false);
  assert.equal(result.problems[0].code, 'incomplete');
  assert.equal(calls.length, 1);
});

for (const total of [MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS + 1]) {
  test(`load: respect search cap for ${total} matches`, async () => {
    const responses = Array.from({ length: MAX_SEARCH_RESULTS / RESULTS_PER_PAGE }, (_, pageIndex) => page(
      Array.from({ length: RESULTS_PER_PAGE }, (_, index) => pullRequest({ id: pageIndex * RESULTS_PER_PAGE + index + 1 })),
      { total },
    ));
    const { client, calls } = fixture(responses);
    const result = await client.load('repos=owner/*');
    assert.equal(result.pullRequests.length, MAX_SEARCH_RESULTS);
    assert.equal(calls.length, MAX_SEARCH_RESULTS / RESULTS_PER_PAGE);
    assert.equal(result.complete, total === MAX_SEARCH_RESULTS);
    assert.deepEqual(result.problems.map(problem => problem.code), total > MAX_SEARCH_RESULTS ? ['capped'] : []);
  });
}

for (const data of [
  null,
  [],
  {},
  { total_count: -1, incomplete_results: false, items: [] },
  { total_count: '0', incomplete_results: false, items: [] },
  { total_count: 0.5, incomplete_results: false, items: [] },
  { total_count: Number.MAX_SAFE_INTEGER + 1, incomplete_results: false, items: [] },
  { total_count: 0, incomplete_results: 'false', items: [] },
  { total_count: 0, incomplete_results: false, items: null },
  { total_count: RESULTS_PER_PAGE + 1, incomplete_results: false, items: Array(RESULTS_PER_PAGE + 1).fill(pullRequest()) },
]) {
  test(`load: reject malformed page ${JSON.stringify(data).slice(0, 100)}`, async () => {
    const { client } = fixture([Response.json(data)]);
    const result = await client.load('repos=owner/*');
    assert.equal(result.complete, false);
    assert.equal(result.problems[0].code, 'invalid-response');
    assert.deepEqual(result.pullRequests, []);
  });
}

for (const overrides of [
  { id: 0 },
  { id: Number.MAX_SAFE_INTEGER + 1 },
  { number: -1 },
  { title: {} },
  { draft: undefined },
  { draft: 'false' },
  { state: 'unknown' },
  { user: undefined },
  { user: { login: '' } },
  { user: { login: 1 } },
  { repository: { archived: 'false' } },
  { updated_at: '3' },
  { updated_at: '2026-99-99T00:00:00Z' },
  { pull_request: 'true' },
  { pull_request: { merged_at: false } },
  { repository_url: 'https://evil.example/repos/owner/repo' },
  { repository_url: 'https://api.github.com@evil.example/repos/owner/repo' },
  { repository_url: 'https://api.github.com/repos/owner/../repo' },
  { repository_url: 'https://api.github.com/repos/owner/repo?query' },
  { repository_url: 'https://api.github.com/repos/owner/%72epo' },
  { repository_url: 'https://api.github.com/repos/owner/..' },
  { html_url: 'javascript:alert(1)' },
  { html_url: 'http://github.com/owner/repo/pull/1' },
  { html_url: 'https://github.com.evil.example/owner/repo/pull/1' },
  { html_url: 'https://github.com@evil.example/owner/repo/pull/1' },
  { html_url: 'https://github.com/other/repo/pull/1' },
  { html_url: 'https://github.com/owner/repo/pull/2' },
  { html_url: 'https://github.com/owner/repo/issues/1' },
  { html_url: 'https://github.com/owner/repo/pull/1?redirect=evil' },
]) {
  test(`load: reject malformed PR ${JSON.stringify(overrides)}`, async () => {
    const { client } = fixture([page([pullRequest(overrides)])]);
    const result = await client.load('repos=owner/*');
    assert.equal(result.problems[0].code, 'invalid-response');
    assert.deepEqual(result.pullRequests, []);
  });
}

test('load: bound retained titles and authors independently of response size', async () => {
  const title = 'x'.repeat(MAX_TITLE_LENGTH);
  const login = 'x'.repeat(MAX_AUTHOR_LENGTH);
  const { client } = fixture([
    page([pullRequest({ title, user: { login } })]),
    page([pullRequest({ title: `${title}x` })]),
    page([pullRequest({ user: { login: `${login}x` } })]),
  ]);
  assert.equal((await client.load('repos=owner/*')).complete, true);
  assert.equal((await client.load('repos=owner/*')).problems[0].code, 'invalid-response');
  assert.equal((await client.load('repos=owner/*')).problems[0].code, 'invalid-response');
});

test('load: malformed page entries cannot partially mutate results', async () => {
  const { client } = fixture([page([pullRequest(), null])]);
  const result = await client.load('repos=owner/*');
  assert.deepEqual(result.pullRequests, []);
  assert.equal(result.pagesLoaded, 0);
  assert.equal(result.problems[0].code, 'invalid-response');
});

for (const response of [new Response('<html>not JSON</html>'), new Response(null)]) {
  test('load: malformed successful response is an explicit failure', async () => {
    const { client } = fixture([response]);
    const result = await client.load('repos=owner/*');
    assert.equal(result.complete, false);
    assert.equal(result.problems[0].code, 'invalid-response');
  });
}

test('load: bound streamed response size and cancel oversized body', async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1)); },
    cancel() { cancelled = true; },
  });
  const { client } = fixture([new Response(stream)]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.problems[0].code, 'invalid-response');
  assert.match(result.problems[0].message, /payload limit/);
  assert.equal(cancelled, true);
});

test('load: decode UTF-8 across response chunks', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ total_count: 1, incomplete_results: false, items: [pullRequest({ title: 'Add café support' })] }));
  const split = bytes.indexOf(0xc3) + 1;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  });
  const { client } = fixture([new Response(stream)]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.pullRequests[0].title, 'Add café support');
});

for (const { status, code, body } of [
  { status: 403, code: 'http', body: 'Forbidden' },
  { status: 404, code: 'http', body: 'Not found' },
  { status: 422, code: 'invalid-scope', body: 'Validation failed' },
  { status: 500, code: 'http', body: '<html>Server error</html>' },
  { status: 503, code: 'http', body: null },
]) {
  test(`load: retain successful scopes after HTTP ${status}`, async () => {
    const { client, calls } = fixture([
      page([pullRequest()]),
      new Response(body, { status }),
      page([pullRequest({ id: 3, repositoryName: 'third/repo' })]),
    ]);
    const result = await client.load('repos=owner/*,second/*,third/*');
    assert.equal(result.complete, false);
    assert.equal(calls.length, 3);
    assert.equal(result.pagesLoaded, 2);
    assert.deepEqual(result.pullRequests.map(pr => pr.id), [1, 3]);
    assert.equal(result.problems[0].code, code);
    assert.equal(result.problems[0].status, status);
    assert.equal(result.problems[0].scope, 'org:second');
  });
}

test('load: network failure retains earlier pages without retrying failed page', async () => {
  const { client, calls } = fixture([
    fullPage([pullRequest()]),
    () => { throw new TypeError('Network unavailable'); },
  ]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.complete, false);
  assert.equal(result.problems[0].code, 'network');
  assert.equal(result.problems[0].page, 2);
  assert.equal(result.pullRequests.length, 1);
  assert.equal(calls.length, 2);
});

for (const { status, body, headers, delay } of [
  { status: 429, body: 'Too many requests', headers: {}, delay: MINUTE_MS },
  { status: 403, body: { message: 'API rate limit exceeded' }, headers: {}, delay: MINUTE_MS },
  { status: 403, body: { message: 'Secondary rate limit' }, headers: { 'retry-after': '90' }, delay: 90 * SECOND_MS },
  { status: 403, body: 'Forbidden', headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((START + MINUTE_MS) / SECOND_MS) }, delay: MINUTE_MS },
  { status: 429, body: '', headers: { 'retry-after': new Date(START + MINUTE_MS).toUTCString() }, delay: MINUTE_MS },
  { status: 429, body: '', headers: { 'retry-after': '30', 'x-ratelimit-reset': String((START + MINUTE_MS) / SECOND_MS) }, delay: MINUTE_MS },
  { status: 429, body: '', headers: { 'retry-after': 'invalid', 'x-ratelimit-reset': '999999999999999999999' }, delay: MINUTE_MS },
  { status: 429, body: '', headers: { 'x-ratelimit-reset': '0' }, delay: MINUTE_MS },
]) {
  test(`load: rate limit ${status} ${JSON.stringify(headers)} stops remaining scopes`, async () => {
    const response = typeof body === 'object' ? Response.json(body, { status, headers }) : new Response(body, { status, headers });
    const { client, calls } = fixture([response]);
    const result = await client.load('repos=owner/*,other/*');
    assert.equal(result.complete, false);
    assert.equal(result.problems[0].code, 'rate-limit');
    assert.equal(result.problems[0].status, status);
    assert.equal(result.retryAt, START + delay);
    assert.equal(calls.length, 1);
  });
}

test('load: successful exhausted response blocks subsequent pages and manual reloads until reset', async () => {
  const reset = START + MINUTE_MS;
  const { client, calls, advance } = fixture([
    fullPage([pullRequest()], { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset / SECOND_MS) } }),
    page([pullRequest()]),
  ]);
  const first = await client.load('repos=owner/*');
  assert.equal(first.complete, false);
  assert.equal(first.pullRequests.length, 1);
  assert.equal(first.retryAt, reset);
  assert.equal(first.problems[0].page, 2);
  const blocked = await client.load('repos=owner/*');
  assert.equal(blocked.requests, 0);
  assert.equal(blocked.problems[0].code, 'rate-limit');
  assert.equal(calls.length, 1);
  advance(MINUTE_MS);
  const retried = await client.load('repos=owner/*');
  assert.equal(retried.complete, true);
  assert.equal(retried.retryAt, null);
  assert.equal(calls.length, 2);
});

test('load: exhaustion on final page preserves complete result and exposes refresh deadline', async () => {
  const { client } = fixture([page([pullRequest()], { headers: { 'x-ratelimit-remaining': '0' } })]);
  const result = await client.load('repos=owner/*');
  assert.equal(result.complete, true);
  assert.equal(result.retryAt, START + MINUTE_MS);
});

test('load: request spacing persists across loads', async () => {
  const { client, waits } = fixture([page(), page()]);
  await client.load('repos=owner/*');
  await client.load('repos=owner/*');
  assert.deepEqual(waits, [SEARCH_INTERVAL_MS]);
});

test('load: already cancelled load makes no request', async () => {
  const { client, calls } = fixture([]);
  await assert.rejects(client.load('repos=owner/*', { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('load: external cancellation aborts pending fetch', async () => {
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  const { client } = fixture([(_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered.resolve(signal);
  })]);
  const loading = client.load('repos=owner/*', { signal: controller.signal });
  const rejected = assert.rejects(loading, { name: 'AbortError' });
  const requestSignal = await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('load: new load aborts obsolete load and ignores its late response and rate headers', async () => {
  const late = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const { client, calls } = fixture([
    () => { entered.resolve(); return late.promise; },
    page([pullRequest({ id: 2 })]),
    page([pullRequest({ id: 3 })]),
  ]);
  const oldProgress = [];
  const oldLoad = client.load('repos=owner/*', { onProgress: update => oldProgress.push(update.phase) });
  const rejected = assert.rejects(oldLoad, { name: 'AbortError' });
  await entered.promise;
  const current = await client.load('repos=owner/*');
  assert.equal(calls[0].init.signal.aborted, true);
  late.resolve(page([pullRequest()], { headers: { 'x-ratelimit-remaining': '0' } }));
  await rejected;
  assert.deepEqual(current.pullRequests.map(pr => pr.id), [2]);
  assert.deepEqual(oldProgress, ['loading']);
  assert.equal((await client.load('repos=owner/*')).complete, true);
});

test('load: cancellation from progress prevents further requests and stale output', async () => {
  const controller = new AbortController();
  const { client, calls } = fixture([fullPage([pullRequest()])]);
  await assert.rejects(client.load('repos=owner/*', {
    signal: controller.signal,
    onProgress: update => { if (update.phase === 'loaded') controller.abort(); },
  }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});

test('load: progress callback failures are not mislabeled as network errors', async () => {
  const { client } = fixture([]);
  await assert.rejects(client.load('repos=owner/*', { onProgress: () => { throw new Error('render failed'); } }), /render failed/);
});

test('load: request timeout is explicit and other scopes still load', async () => {
  const entered = Promise.withResolvers();
  const timeout = new AbortController();
  let timeouts = 0;
  const { client, calls } = fixture([
    (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      entered.resolve();
    }),
    page([pullRequest({ repositoryName: 'other/repo' })]),
  ], { timeoutSignal: () => timeouts++ === 0 ? timeout.signal : new AbortController().signal });
  const loading = client.load('repos=owner/*,other/*');
  await entered.promise;
  timeout.abort(new DOMException('Timed out', 'TimeoutError'));
  const result = await loading;
  assert.equal(result.complete, false);
  assert.equal(result.problems[0].code, 'timeout');
  assert.equal(result.pullRequests.length, 1);
  assert.equal(calls.length, 2);
});

test('load: default request timeout is bounded', async context => {
  const timeout = context.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, REQUEST_TIMEOUT_MS);
    return new AbortController().signal;
  });
  const { client } = fixture([page()], { timeoutSignal: undefined });
  assert.equal((await client.load('repos=owner/*')).complete, true);
  assert.equal(timeout.mock.callCount(), 1);
});

test('load: timeout covers response-body consumption', async () => {
  const entered = Promise.withResolvers();
  const timeout = new AbortController();
  const { client } = fixture([(_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      entered.resolve();
    },
  }))], { timeoutSignal: () => timeout.signal });
  const loading = client.load('repos=owner/*');
  await entered.promise;
  timeout.abort(new DOMException('Timed out', 'TimeoutError'));
  assert.equal((await loading).problems[0].code, 'timeout');
});

test('load: default wait can be cancelled without waiting for timer', async () => {
  const controller = new AbortController();
  const waiting = Promise.withResolvers();
  const { client, calls } = fixture([fullPage([pullRequest()])], { wait: undefined });
  const loading = client.load('repos=owner/*', {
    signal: controller.signal,
    onProgress: update => { if (update.phase === 'waiting') waiting.resolve(); },
  });
  const rejected = assert.rejects(loading, { name: 'AbortError' });
  await waiting.promise;
  controller.abort();
  await rejected;
  assert.equal(calls.length, 1);
});

test('load: default wait finishes before next request', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = Promise.withResolvers();
  const { client, calls } = fixture([page(), page()], { wait: undefined });
  const loading = client.load('repos=owner/*,other/*', {
    onProgress: update => { if (update.phase === 'waiting') waiting.resolve(); },
  });
  await waiting.promise;
  assert.equal(calls.length, 1);
  context.mock.timers.tick(SEARCH_INTERVAL_MS);
  assert.equal((await loading).complete, true);
  assert.equal(calls.length, 2);
});
