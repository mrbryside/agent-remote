// Apply the persisted layout while the document is still parsing, so the
// first styled frame already has the final sidebar geometry.
document.currentScript.parentElement.dataset.sidebar =
  document.documentElement.dataset.initialSidebar || 'expanded';
