import {
  buildSearchScopes,
  isReadyTitle,
  matchesRepository,
  normalizeSelector,
  parseQuery,
} from './query.mjs';

// GitHub caps search pages and accessible matches per query.
export const RESULTS_PER_PAGE = 100;
export const MAX_SEARCH_RESULTS = 1000;

// Unauthenticated search permits ten requests per minute.
export const SEARCH_INTERVAL_MS = 6000;

// A stalled request must not block remaining scopes indefinitely.
export const REQUEST_TIMEOUT_MS = 30_000;

// Large PR bodies must not exhaust browser memory.
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

// Bound retained metadata independently of discarded PR bodies.
export const MAX_TITLE_LENGTH = 1024;
export const MAX_AUTHOR_LENGTH = 128;

// Keep searches short; exclusions that do not fit still apply locally.
const MAX_SEARCH_QUERY_LENGTH = 256;

// GitHub requires at least one minute before retrying an unspecified secondary limit.
const RATE_LIMIT_FALLBACK_MS = 60_000;
const SECOND_MS = 1000;
const API_ORIGIN = 'https://api.github.com';
const WEB_ORIGIN = 'https://github.com';

export const SEARCH_LIMITATIONS = Object.freeze([
  'GitHub search scans at most 4,000 repositories per query.',
  'GitHub search indexing can lag repository and pull request changes.',
]);

class GitHubError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.code = code;
    this.status = options.status ?? null;
    this.retryAt = options.retryAt ?? null;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function readTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
    return NaN;
  }
  return Date.parse(value);
}

function readItem(item, query) {
  if (!isRecord(item) || !isPositiveInteger(item.id) || !Number.isFinite(readTimestamp(item.updated_at))) {
    throw new GitHubError('invalid-response', 'GitHub returned an invalid search entry.');
  }

  const snapshot = { id: item.id, updatedAt: readTimestamp(item.updated_at), pullRequest: null };
  if (item.pull_request === undefined || item.pull_request === null) return snapshot;

  if (!isRecord(item.pull_request) || !isPositiveInteger(item.number) ||
      typeof item.title !== 'string' || item.title.length > MAX_TITLE_LENGTH || typeof item.draft !== 'boolean' ||
      !['open', 'closed'].includes(item.state) ||
      !(item.user === null || (isRecord(item.user) && typeof item.user.login === 'string' &&
        item.user.login.length <= MAX_AUTHOR_LENGTH && item.user.login.trim())) ||
      (item.repository !== undefined && (!isRecord(item.repository) || typeof item.repository.archived !== 'boolean')) ||
      (item.pull_request.merged_at != null && !Number.isFinite(readTimestamp(item.pull_request.merged_at)))) {
    throw new GitHubError('invalid-response', 'GitHub returned an invalid pull request.');
  }

  const repositoryMatch = typeof item.repository_url === 'string' &&
    /^https:\/\/api\.github\.com\/repos\/([a-z0-9-]+\/[a-z0-9_.-]+)$/i.exec(item.repository_url);
  let repository;
  try {
    repository = normalizeSelector(repositoryMatch ? repositoryMatch[1] : '');
  } catch (cause) {
    throw new GitHubError('invalid-response', 'GitHub returned an invalid repository URL.', { cause });
  }

  const url = `${WEB_ORIGIN}/${repository}/pull/${item.number}`;
  if (typeof item.html_url !== 'string' || item.html_url.toLowerCase() !== url) {
    throw new GitHubError('invalid-response', 'GitHub returned an invalid pull request URL.');
  }

  if (item.state !== 'open' || item.draft || item.repository?.archived || item.pull_request.merged_at != null ||
      !matchesRepository(repository, query) || !isReadyTitle(item.title)) {
    return snapshot;
  }

  snapshot.pullRequest = {
    id: item.id,
    repository,
    number: item.number,
    title: item.title,
    author: item.user?.login ?? null,
    url,
    updatedAt: snapshot.updatedAt,
  };
  return snapshot;
}

function readPage(data, query) {
  if (!isRecord(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
      typeof data.incomplete_results !== 'boolean' || !Array.isArray(data.items) || data.items.length > RESULTS_PER_PAGE) {
    throw new GitHubError('invalid-response', 'GitHub returned an invalid search page.');
  }
  return {
    total: data.total_count,
    incomplete: data.incomplete_results,
    items: data.items.map(item => readItem(item, query)),
  };
}

function searchQuery(scope, query) {
  let search = `is:pr is:open archived:false draft:false ${scope}`;
  if (scope.startsWith('org:')) {
    const owner = scope.slice('org:'.length);
    for (const repository of query.exclude) {
      if (!repository.startsWith(`${owner}/`)) continue;
      const candidate = `${search} -repo:${repository}`;
      if (candidate.length <= MAX_SEARCH_QUERY_LENGTH) search = candidate;
    }
  }
  return search;
}

function integerHeader(headers, name) {
  const value = headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return null;
  const integer = Number(value);
  return Number.isSafeInteger(integer) ? integer : null;
}

function retryAt(headers, now) {
  const reset = integerHeader(headers, 'x-ratelimit-reset');
  const after = headers.get('retry-after');
  const seconds = integerHeader(headers, 'retry-after');
  const candidates = [
    reset === null ? NaN : reset * SECOND_MS,
    seconds === null ? Date.parse(after ?? '') : now + seconds * SECOND_MS,
  ].filter(value => Number.isFinite(new Date(value).getTime()) && value > now);
  return candidates.length ? Math.max(...candidates) : now + RATE_LIMIT_FALLBACK_MS;
}

async function readBody(response, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new GitHubError('invalid-response', 'GitHub response exceeds the payload limit.');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    try {
      await reader.cancel();
    } finally {
      throw error;
    }
  } finally {
    reader.releaseLock();
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createGitHubClient({
  fetch: fetchImpl = globalThis.fetch,
  now = Date.now,
  wait = delay,
  timeoutSignal = () => AbortSignal.timeout(REQUEST_TIMEOUT_MS),
} = {}) {
  let activeController;
  let nextRequestAt = 0;
  let blockedUntil = 0;

  async function request(url, signal) {
    const requestSignal = AbortSignal.any([signal, timeoutSignal()]);
    try {
      requestSignal.throwIfAborted();
      const response = await fetchImpl(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: requestSignal,
      });
      requestSignal.throwIfAborted();
      const exhausted = integerHeader(response.headers, 'x-ratelimit-remaining') === 0;
      if (exhausted || response.status === 429 || response.headers.has('retry-after')) {
        blockedUntil = Math.max(blockedUntil, retryAt(response.headers, now()));
      }

      const text = await readBody(response, requestSignal);
      let data;
      try {
        data = JSON.parse(text);
      } catch (cause) {
        if (response.ok) {
          throw new GitHubError('invalid-response', 'GitHub returned invalid JSON.', { cause });
        }
      }
      if (!response.ok) {
        const limited = response.status === 429 || (response.status === 403 &&
          (exhausted || response.headers.has('retry-after') ||
            (typeof data?.message === 'string' && /rate limit/i.test(data.message))));
        if (limited) {
          blockedUntil = Math.max(blockedUntil, retryAt(response.headers, now()));
          throw new GitHubError('rate-limit', 'GitHub rate limit reached.', {
            status: response.status,
            retryAt: blockedUntil,
          });
        }
        if (response.status === 422) {
          throw new GitHubError('invalid-scope', 'GitHub could not search this scope (HTTP 422).', { status: response.status });
        }
        throw new GitHubError('http', `GitHub returned HTTP ${response.status}.`, { status: response.status });
      }
      return data;
    } catch (cause) {
      signal.throwIfAborted();
      if (requestSignal.aborted) {
        throw new GitHubError('timeout', 'GitHub request timed out.', { cause });
      }
      if (cause instanceof GitHubError) throw cause;
      throw new GitHubError('network', 'GitHub request failed; check connectivity and browser access.', { cause });
    }
  }

  async function load(search, { signal: externalSignal, onProgress = () => {} } = {}) {
    activeController?.abort();
    activeController = new AbortController();
    const signal = externalSignal ? AbortSignal.any([activeController.signal, externalSignal]) : activeController.signal;
    signal.throwIfAborted();
    const query = parseQuery(search);
    const scopes = buildSearchScopes(query);
    const snapshots = new Map();
    const problems = [];
    let requests = 0;
    let pagesLoaded = 0;
    let count = 0;
    let completedScopes = 0;

    const addProblem = problem => {
      if (!problems.some(existing => existing.scope === problem.scope && existing.code === problem.code)) {
        problems.push(problem);
      }
    };
    const progress = (phase, scope, page, waitUntil = null) => {
      signal.throwIfAborted();
      onProgress({ phase, scope, page, scopeCount: scopes.length, completedScopes, requests, count, waitUntil });
      signal.throwIfAborted();
    };

    scopesLoop: for (const scope of scopes) {
      for (let page = 1; page <= MAX_SEARCH_RESULTS / RESULTS_PER_PAGE; page++) {
        signal.throwIfAborted();
        if (blockedUntil > now()) {
          addProblem({ code: 'rate-limit', message: 'GitHub rate limit reached.', scope, page, retryAt: blockedUntil });
          break scopesLoop;
        }
        if (nextRequestAt > now()) {
          progress('waiting', scope, page, nextRequestAt);
          await wait(nextRequestAt - now(), signal);
          signal.throwIfAborted();
        }

        const url = new URL('/search/issues', API_ORIGIN);
        url.search = new URLSearchParams({ q: searchQuery(scope, query), per_page: RESULTS_PER_PAGE, sort: 'updated', order: 'asc', page });
        progress('loading', scope, page);
        nextRequestAt = now() + SEARCH_INTERVAL_MS;
        requests++;

        let result;
        try {
          result = readPage(await request(url.href, signal), query);
          signal.throwIfAborted();
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof GitHubError)) throw error;
          addProblem({ code: error.code, message: error.message, status: error.status, retryAt: error.retryAt, scope, page });
          if (error.code === 'rate-limit') break scopesLoop;
          break;
        }

        pagesLoaded++;
        for (const snapshot of result.items) {
          const previous = snapshots.get(snapshot.id);
          if (previous && previous.updatedAt > snapshot.updatedAt) continue;
          if (previous?.pullRequest) count--;
          if (snapshot.pullRequest) count++;
          snapshots.set(snapshot.id, snapshot);
        }
        const expectedItems = Math.min(RESULTS_PER_PAGE, Math.max(0, result.total - (page - 1) * RESULTS_PER_PAGE));
        if (result.incomplete || result.items.length !== expectedItems) {
          addProblem({ code: 'incomplete', message: 'GitHub returned incomplete search results.', scope, page });
        }
        if (result.total > MAX_SEARCH_RESULTS) {
          addProblem({ code: 'capped', message: `GitHub exposes only ${MAX_SEARCH_RESULTS.toLocaleString('en-US')} matches per search.`, scope, page });
        }
        progress('loaded', scope, page);
        if (result.items.length === 0 || page * RESULTS_PER_PAGE >= result.total) break;
      }
      completedScopes++;
    }

    signal.throwIfAborted();
    return {
      pullRequests: [...snapshots.values()]
        .filter(snapshot => snapshot.pullRequest !== null)
        .map(snapshot => snapshot.pullRequest)
        .sort((left, right) => left.updatedAt - right.updatedAt || left.id - right.id),
      complete: problems.length === 0,
      problems,
      pagesLoaded,
      requests,
      retryAt: blockedUntil > now() ? blockedUntil : null,
      limitations: SEARCH_LIMITATIONS,
    };
  }

  return { load };
}
