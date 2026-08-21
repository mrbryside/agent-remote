const documentRoot = document.documentElement;
documentRoot.dataset.sidebarBooting = 'true';
documentRoot.dataset.initialSidebar = matchMedia('(max-width: 760px)').matches
  ? 'collapsed'
  : 'expanded';
try {
  if (localStorage.getItem('agent-remote-session')) {
    documentRoot.dataset.restoringSession = 'true';
  }
  const savedSidebarWidth = Number(localStorage.getItem('agent-remote-sidebar-width'));
  if (Number.isFinite(savedSidebarWidth) && savedSidebarWidth > 0) {
    documentRoot.style.setProperty('--sidebar-width', `${savedSidebarWidth}px`);
  }
  if (!matchMedia('(max-width: 760px)').matches &&
      localStorage.getItem('agent-remote-sidebar-collapsed') === 'true') {
    documentRoot.dataset.initialSidebar = 'collapsed';
  }
} catch {}
