// Thread panel script. Scrolls to the tool call that wrote the hovered line,
// and forwards header button clicks to the extension. It sends action names
// only; the extension decides what each one does from its own state.
(function () {
  const vscode = acquireVsCodeApi();
  // Each render has a new nonce. The same nonce means VS Code reloaded this page
  // (it does when the panel is hidden and shown again), so the reader's scroll
  // position is restored instead of jumping back to the target.
  const render = document.currentScript ? document.currentScript.nonce : '';
  const saved = vscode.getState();
  let restoreY = saved && saved.render === render && typeof saved.scrollY === 'number' ? saved.scrollY : null;

  function reveal(id) {
    for (const element of document.querySelectorAll('.target')) element.classList.remove('target');
    let found = null;
    if (id) {
      for (const element of document.querySelectorAll('[data-tool]')) {
        if (element.dataset.tool === id) {
          found = element;
          break;
        }
      }
    }
    if (found) {
      // A tool call inside a collapsed summary has to be opened to be seen.
      const group = found.closest('details');
      if (group) group.open = true;
      found.classList.add('target');
      if (restoreY === null) found.scrollIntoView({ block: 'center' });
    }
    if (restoreY !== null) window.scrollTo(0, restoreY);
    restoreY = null;
    // Lets the extension (and its tests) know what the panel is showing.
    vscode.postMessage({ type: 'revealed', id: id, found: found !== null });
  }

  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (button) vscode.postMessage({ type: button.dataset.action });
  });

  window.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'reveal') reveal(String(event.data.id));
  });

  let pending = 0;
  window.addEventListener('scroll', () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = 0;
      vscode.setState({ render: render, scrollY: window.scrollY });
    }, 100);
  });

  // A page loaded before it was laid out can't scroll yet; wait for its first size.
  function start() {
    reveal(document.body.dataset.target);
  }
  if (document.documentElement.clientHeight > 0) start();
  else window.addEventListener('resize', start, { once: true });
})();
