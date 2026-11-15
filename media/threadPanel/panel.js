// Thread panel script. Scrolls to the tool call that wrote the hovered line,
// and forwards header button clicks to the extension. It sends action names
// only; the extension decides what each one does from its own state.
(function () {
  const vscode = acquireVsCodeApi();

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
      found.scrollIntoView({ block: 'center' });
    }
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

  reveal(document.body.dataset.target);
})();
