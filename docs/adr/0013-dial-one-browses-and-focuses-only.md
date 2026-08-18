---
status: accepted
---

# Dial 1 browses and focuses only

ADR-0007 assigned two jobs to dial 1: browse and focus a workstream's panes, then scrub the selected pane's scrollback. The browse-and-focus half remains. The scrollback half is withdrawn.

Herdr 0.8 protocol 19 reports scroll state but exposes no request for changing it. The plugin had implemented an unverified `pane.scroll` request anyway. A physical-device test then exposed a second problem: the prebuilt runtime shipped by the installer predated the dial source, so neither behavior was actually available to validate.

Dial 1 now has one complete interaction:

- turning previews panes and paneless attention without sending a request;
- pushing a pane sends the verified `pane.focus` request and clears the preview;
- pushing paneless attention does nothing because it names no pane;
- the next turn starts browsing again.

Scrollback control can return only when Herdr publishes a supported request and it is verified against a running instance. The committed prebuilt runtime is also checked against a fresh Rollup generation so source-only dial changes cannot silently miss the installer again.
