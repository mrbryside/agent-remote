# Browser renderer

The integrated terminal browser is not rendered inside the agent's tmux pane. The routing shim sends an owning-session request to `src/server.js`, which starts a separate graphics PTY and connects to the browser daemon through CDP. This avoids Kitty placeholder output in the main terminal.

Each session owns one keyed renderer and one UI split state. The browser toolbar reflects the daemon's real tabs, while back/forward/reload, tab changes, Inspect, and Record are routed to that renderer. Refresh and session switching reattach to the same backend renderer; closing the final tab, split, session, or project must clean up the renderer and daemon.

The page viewport is streamed as latest-frame-wins images at CSS-pixel coordinates. High-resolution settled frames improve static clarity, while animation frames use backpressure to avoid queueing stale images. Pointer input and cursor probing remain in CSS pixels. DevTools docks below the same target; its duplicate screencast is disabled so the picker inspects the primary viewport.

Changes here require the real-browser coverage in `test/terminal-browser.spec.js` in addition to the general Playwright suite. The real terminal-browser case may skip when its machine binary is unavailable.

[Back to architecture index](index.md)
