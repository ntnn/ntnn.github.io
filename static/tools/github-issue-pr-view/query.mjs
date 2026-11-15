// Bound parsing allocations from untrusted URL queries.
export const MAX_QUERY_LENGTH = 8192;

// Bound search scopes before duplicate removal can hide oversized input.
export const MAX_SELECTORS = 50;

// Entry kinds accepted by the type parameter; all selects issues and pull requests.
export const TYPES = Object.freeze(['all', 'issue', 'pr']);

// GitHub limits account and repository name lengths.
const MAX_OWNER_LENGTH = 39;
const MAX_REPOSITORY_LENGTH = 100;

const TITLE_MARKER = '(?:wip|work[\\s-]+in[\\s-]+progress|draft|dnm|do[\\s-]+not[\\s-]+merge)';
const BRACKETED_TITLE_MARKER = new RegExp(`(?:\\[\\s*${TITLE_MARKER}\\s*\\]|\\(\\s*${TITLE_MARKER}\\s*\\))`, 'i');
const PREFIX_TITLE_MARKER = new RegExp(`^\\s*${TITLE_MARKER}(?:$|[\\s:–—-])`, 'i');

export function normalizeSelector(value, { allowWildcard = false } = {}) {
  if (typeof value !== 'string') {
    throw new TypeError('Selector must be a string.');
  }

  const selector = value.trim();
  const parts = selector.split('/');
  const [owner, repository] = parts;
  const validOwner = owner.length <= MAX_OWNER_LENGTH && /^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(owner);
  const validRepository = repository && repository.length <= MAX_REPOSITORY_LENGTH &&
    /^[a-z0-9_.-]+$/i.test(repository) && repository !== '.' && repository !== '..';

  if (parts.length !== 2 || !validOwner || !(validRepository || (allowWildcard && repository === '*'))) {
    const expected = allowWildcard ? 'owner/repository or organization/*' : 'owner/repository';
    throw new Error(`Invalid selector ${JSON.stringify(value)}; expected ${expected}.`);
  }

  return selector.toLowerCase();
}

export function parseQuery(search = '') {
  if (typeof search !== 'string') {
    throw new TypeError('Query must be a string.');
  }
  if (search.length > MAX_QUERY_LENGTH) {
    throw new RangeError(`Query exceeds ${MAX_QUERY_LENGTH} characters.`);
  }

  const params = new URLSearchParams(search);
  const query = { repos: [], exclude: [], type: 'all' };
  let selectorCount = 0;

  for (const key of ['repos', 'exclude']) {
    const selectors = new Set();
    for (const value of params.getAll(key)) {
      if (!value.trim()) continue;

      const entries = value.split(',');
      selectorCount += entries.length;
      if (selectorCount > MAX_SELECTORS) {
        throw new RangeError(`Query exceeds ${MAX_SELECTORS} selectors across repos and exclude.`);
      }

      for (const entry of entries) {
        selectors.add(normalizeSelector(entry, { allowWildcard: key === 'repos' }));
      }
    }
    query[key] = [...selectors];
  }

  const organizations = new Set(query.repos.filter(selector => selector.endsWith('/*')));
  query.repos = query.repos.filter(selector => {
    const [owner, repository] = selector.split('/');
    return repository === '*' || !organizations.has(`${owner}/*`);
  });

  const types = params.getAll('type').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (types.length > 1) {
    throw new Error('Query accepts a single type.');
  }
  if (types.length === 1) {
    if (!TYPES.includes(types[0])) {
      throw new Error(`Invalid type ${JSON.stringify(types[0])}; expected ${TYPES.join(', ')}.`);
    }
    query.type = types[0];
  }

  return query;
}

export function serializeQuery(query) {
  const params = new URLSearchParams();
  for (const key of ['repos', 'exclude']) {
    if (query[key].length) params.set(key, query[key].join(','));
  }
  if (query.type !== 'all') params.set('type', query.type);
  return params.toString();
}

export function matchesRepository(repository, query) {
  const selector = normalizeSelector(repository);
  if (query.exclude.includes(selector)) return false;

  const [owner] = selector.split('/');
  return query.repos.includes(selector) || query.repos.includes(`${owner}/*`);
}

export function buildSearchScopes(query) {
  return query.repos
    .filter(selector => !query.exclude.includes(selector))
    .map(selector => {
      if (selector.endsWith('/*')) return `org:${selector.slice(0, -2)}`;
      return `repo:${selector}`;
    });
}

export function isReadyTitle(title) {
  if (typeof title !== 'string' || !title.trim()) return false;
  return !BRACKETED_TITLE_MARKER.test(title) && !PREFIX_TITLE_MARKER.test(title);
}
