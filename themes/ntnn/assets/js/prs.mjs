import { createGitHubClient, SEARCH_LIMITATIONS } from './prs/github.mjs';
import { MAX_QUERY_LENGTH, parseQuery } from './prs/query.mjs';

// Browsers clamp larger timer delays to a near-immediate callback.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

function initPRPage(root) {
  const form = root.querySelector('#prs-form');
  const reposInput = root.querySelector('#prs-repos');
  const excludeInput = root.querySelector('#prs-exclude');
  const applyButton = root.querySelector('#prs-apply');
  const refreshButton = root.querySelector('#prs-refresh');
  const status = root.querySelector('#prs-status');
  const cooldown = root.querySelector('#prs-cooldown');
  const problems = root.querySelector('#prs-problems');
  const results = root.querySelector('#prs-results');
  const rows = root.querySelector('#prs-rows');
  const limitations = root.querySelector('#prs-limitations');
  const client = createGitHubClient();
  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' });
  let activeController;
  let loading = false;
  let hasQuery = false;
  let retryAt = null;
  let unlockTimer;

  reposInput.maxLength = MAX_QUERY_LENGTH;
  excludeInput.maxLength = MAX_QUERY_LENGTH;
  if (window.location.search.length <= MAX_QUERY_LENGTH) {
    const params = new URLSearchParams(window.location.search);
    reposInput.value = params.getAll('repos').filter(value => value.trim()).join(',');
    excludeInput.value = params.getAll('exclude').filter(value => value.trim()).join(',');
  }
  for (const limitation of SEARCH_LIMITATIONS) {
    const item = document.createElement('li');
    item.textContent = limitation;
    limitations.append(item);
  }

  function setStatus(state, text) {
    status.dataset.state = state;
    status.textContent = text;
  }

  function timeElement(timestamp) {
    const time = document.createElement('time');
    time.dateTime = new Date(timestamp).toISOString();
    time.title = time.dateTime;
    time.textContent = dateFormat.format(timestamp);
    return time;
  }

  function updateControls() {
    clearTimeout(unlockTimer);
    const remaining = retryAt === null ? 0 : retryAt - Date.now();
    applyButton.disabled = remaining > 0;
    refreshButton.disabled = loading || remaining > 0;
    refreshButton.hidden = !hasQuery;
    cooldown.hidden = remaining <= 0;
    if (remaining > 0) {
      cooldown.replaceChildren('Requests paused until ', timeElement(retryAt), '. Retry manually after reset.');
      unlockTimer = setTimeout(updateControls, Math.min(remaining, MAX_TIMER_DELAY_MS));
    } else {
      cooldown.replaceChildren();
    }
  }

  function clearResults() {
    rows.replaceChildren();
    results.hidden = true;
    problems.replaceChildren();
    problems.hidden = true;
  }

  function showInvalidQuery(error) {
    activeController?.abort();
    activeController = null;
    loading = false;
    hasQuery = false;
    clearResults();
    results.setAttribute('aria-busy', 'false');
    setStatus('invalid', `Invalid query: ${error.message}`);
    updateControls();
  }

  function countLabel(count) {
    return `${count.toLocaleString()} ${count === 1 ? 'pull request' : 'pull requests'}`;
  }

  function renderProgress(update) {
    const matched = `${countLabel(update.count)} matched so far.`;
    if (update.phase === 'waiting') {
      setStatus('loading', `${matched} Next request at ${dateFormat.format(update.waitUntil)}.`);
    } else if (update.phase === 'loading') {
      setStatus('loading', `Loading ${update.scope}, page ${update.page} (scope ${update.completedScopes + 1} of ${update.scopeCount}). ${matched}`);
    } else {
      setStatus('loading', `Loaded ${update.scope}, page ${update.page}. ${matched}`);
    }
  }

  function cell(value) {
    const element = document.createElement('td');
    element.append(value);
    return element;
  }

  function renderResult(result) {
    const fragment = document.createDocumentFragment();
    for (const pr of result.pullRequests) {
      const link = document.createElement('a');
      link.href = pr.url;
      link.textContent = `#${pr.number} ${pr.title}`;
      const row = document.createElement('tr');
      row.append(cell(pr.repository), cell(link), cell(pr.author ?? 'Deleted user'), cell(timeElement(pr.updatedAt)));
      fragment.append(row);
    }
    rows.replaceChildren(fragment);
    results.hidden = result.pullRequests.length === 0;

    for (const problem of result.problems) {
      const item = document.createElement('li');
      item.textContent = `${problem.scope}, page ${problem.page}: ${problem.message}`;
      problems.append(item);
    }
    problems.hidden = result.problems.length === 0;

    const count = countLabel(result.pullRequests.length);
    const limited = result.problems.some(problem => problem.code === 'rate-limit');
    if (result.complete) {
      setStatus(result.pullRequests.length ? 'ready' : 'empty', result.pullRequests.length
        ? `Showing ${count} after filtering.`
        : 'No open pull requests match these filters.');
    } else if (limited) {
      setStatus('rate-limited', result.pagesLoaded
        ? `GitHub rate limit reached. Showing ${count} from partial results.`
        : 'GitHub rate limit reached. No results loaded.');
    } else if (result.pagesLoaded) {
      setStatus('partial', `Partial results: ${count} after filtering. Some results could not be retrieved.`);
    } else {
      setStatus('error', 'Could not load pull requests. See query problems below.');
    }
    refreshButton.textContent = result.complete ? 'Refresh' : 'Retry';
    retryAt = result.retryAt;
  }

  async function load() {
    activeController?.abort();
    const controller = new AbortController();
    activeController = controller;
    clearResults();

    let query;
    try {
      query = parseQuery(window.location.search);
    } catch (error) {
      showInvalidQuery(error);
      return;
    }
    hasQuery = query.repos.length > 0;
    if (!hasQuery) {
      loading = false;
      results.setAttribute('aria-busy', 'false');
      setStatus('idle', 'Enter repositories or open the example. No GitHub requests sent.');
      updateControls();
      return;
    }

    loading = true;
    results.setAttribute('aria-busy', 'true');
    setStatus('loading', 'Loading pull requests from GitHub.');
    updateControls();
    try {
      const result = await client.load(window.location.search, {
        signal: controller.signal,
        onProgress: renderProgress,
      });
      if (activeController !== controller || controller.signal.aborted) return;
      renderResult(result);
    } catch (error) {
      if (activeController !== controller || controller.signal.aborted) return;
      setStatus('error', `Could not load pull requests: ${error instanceof Error ? error.message : 'Unexpected error.'}`);
      refreshButton.textContent = 'Retry';
    } finally {
      if (activeController === controller) {
        loading = false;
        results.setAttribute('aria-busy', 'false');
        updateControls();
      }
    }
  }

  form.addEventListener('submit', event => {
    if (retryAt !== null && retryAt > Date.now()) {
      event.preventDefault();
      updateControls();
      return;
    }
    try {
      parseQuery(new URLSearchParams(new FormData(form)).toString());
    } catch (error) {
      event.preventDefault();
      showInvalidQuery(error);
    }
  });
  refreshButton.addEventListener('click', () => {
    if (!loading && (retryAt === null || retryAt <= Date.now())) void load();
  });
  window.addEventListener('pagehide', () => {
    activeController?.abort();
    clearTimeout(unlockTimer);
  });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (retryAt !== null && retryAt > Date.now()) updateControls();
    else void load();
  });

  void load();
}

const root = document.getElementById('prs');
if (root) initPRPage(root);
