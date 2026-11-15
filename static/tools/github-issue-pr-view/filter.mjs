// Bound the search term before matching it against every title.
export const MAX_SEARCH_LENGTH = 256;

// Author logins containing this marker are listed first.
const PINNED_AUTHOR_MARKER = 'renovate';

function compareText(left, right) {
  return left.localeCompare(right, 'en', { sensitivity: 'base' });
}

function isPinnedAuthor(author) {
  return author !== null && author.toLowerCase().includes(PINNED_AUTHOR_MARKER);
}

function compareAuthors(left, right) {
  if (isPinnedAuthor(left) !== isPinnedAuthor(right)) return isPinnedAuthor(left) ? -1 : 1;
  if ((left === null) !== (right === null)) return left === null ? 1 : -1;
  return compareText(left ?? '', right ?? '');
}

function countValues(values, compare) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.keys()].sort(compare).map(value => ({ value, count: counts.get(value) }));
}

function groupOf(repository) {
  return repository.split('/')[0];
}

// Lists the selectable groups, repositories and authors with their entry counts.
// A null author value stands for deleted users.
export function filterOptions(entries) {
  return {
    groups: countValues(entries.map(entry => groupOf(entry.repository)), compareText),
    repositories: countValues(entries.map(entry => entry.repository), compareText),
    authors: countValues(entries.map(entry => entry.author), compareAuthors),
  };
}

// Returns the entries matching every restricted dimension and the title search.
// Empty groups, repositories or authors restrict nothing; authors may hold null for deleted users.
export function filterEntries(entries, { groups = [], repositories = [], authors = [], text = '' } = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('Search text must be a string.');
  }
  if (text.length > MAX_SEARCH_LENGTH) {
    throw new RangeError(`Search text exceeds ${MAX_SEARCH_LENGTH} characters.`);
  }

  const selectedGroups = new Set(groups);
  const selectedRepositories = new Set(repositories);
  const selectedAuthors = new Set(authors);
  const needle = text.trim().toLowerCase();

  return entries.filter(entry =>
    (selectedGroups.size === 0 || selectedGroups.has(groupOf(entry.repository))) &&
    (selectedRepositories.size === 0 || selectedRepositories.has(entry.repository)) &&
    (selectedAuthors.size === 0 || selectedAuthors.has(entry.author)) &&
    (needle === '' || entry.title.toLowerCase().includes(needle)));
}
