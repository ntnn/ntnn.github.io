// Bound the search term before matching it against every title.
export const MAX_SEARCH_LENGTH = 256;

// Author logins containing one of these markers are listed first.
const PINNED_AUTHOR_MARKERS = Object.freeze(['renovate', 'dependabot']);

function compareText(left, right) {
  return left.localeCompare(right, 'en', { sensitivity: 'base' });
}

function isPinnedAuthor(author) {
  if (author === null) return false;
  const login = author.toLowerCase();
  return PINNED_AUTHOR_MARKERS.some(marker => login.includes(marker));
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

function selectionSet(values) {
  return values === undefined ? undefined : new Set(values);
}

function isSelected(selected, value) {
  return selected === undefined || selected.has(value);
}

// Returns the entries whose group, repository and author are selected and whose title matches the search.
// Omitted groups, repositories or authors restrict nothing, an empty list matches no entry.
// authors may hold null for deleted users.
export function filterEntries(entries, { groups, repositories, authors, text = '' } = {}) {
  if (typeof text !== 'string') {
    throw new TypeError('Search text must be a string.');
  }
  if (text.length > MAX_SEARCH_LENGTH) {
    throw new RangeError(`Search text exceeds ${MAX_SEARCH_LENGTH} characters.`);
  }

  const selectedGroups = selectionSet(groups);
  const selectedRepositories = selectionSet(repositories);
  const selectedAuthors = selectionSet(authors);
  const needle = text.trim().toLowerCase();

  return entries.filter(entry =>
    isSelected(selectedGroups, groupOf(entry.repository)) &&
    isSelected(selectedRepositories, entry.repository) &&
    isSelected(selectedAuthors, entry.author) &&
    (needle === '' || entry.title.toLowerCase().includes(needle)));
}
