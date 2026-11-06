# Layer surfaces for the transparent overlay windows

Status: proposed

## Context

The desktop character and the other overlay windows are transparent, frameless and always on top. On Wayland they stay ordinary `xdg_toplevel` windows:

| Problem | What happens today |
| --- | --- |
| A fullscreen window covers them | The compositor stacks a toplevel below a fullscreen one |
| The window manager places them | Tiling, decorations and taskbar entries apply to a toplevel |
| The app cannot move them | `xdg_toplevel` has no move request. Electron's `setPosition` does nothing |
| A drag does nothing | The renderer skips the native drag helper on Linux, because it needs X11 |

`zwlr_layer_shell_v1` answers all four. A layer surface chooses its layer, size, margins and keyboard interactivity. The compositor places it and keeps it in the layer, so a fullscreen window cannot cover it. No window manager manages it.

Chromium cannot create one. Its Wayland backend speaks `xdg-shell` only, and the role of a `wl_surface` is fixed at the first commit, so a window cannot change role later.

## Decision

Add `packages/electron-wayland-layer-shell`. A proxy process sits on the app's Wayland connection and converts the selected windows.

- The proxy replaces `xdg_surface.get_toplevel` with `zwlr_layer_shell_v1.get_layer_surface` and reuses the client's own object id, so the compositor's object map stays dense.
- The window title carries the window id. `xdg_toplevel.set_title` is the first client-controlled string that names a window, so the proxy holds the role requests until it arrives.
- A suppressed constructor becomes a `wl_display.sync` placeholder on the same id. The client keeps the id for its object, and the compositor never sees it.
- The proxy binds `zwlr_layer_shell_v1` on the suppressed `xdg_surface` id. Chromium does not bind that global, and a fresh id is not accepted by every compositor.
- A drag becomes `set_margin`. The proxy replays the gesture from the pointer position at the press, and it commits for the client, because layer surface state is adopted only at a commit.
- The proxy sends the layer shell and control sockets, and it must start before Chromium opens the Wayland socket. The launcher starts it and starts the app again with the new `WAYLAND_DISPLAY`.

Windows that the proxy does not convert stay ordinary toplevels. The app falls back when the compositor refuses the role.

### Why JavaScript and not a native module

The reference implementation (`YUCLing/open-orpheus` PR 312) hooks `connect` inside the process and filters the protocol in Rust. This repository has no Rust build chain, and a native addon would add one to CI, Flatpak and Nix.

`koffi` calls `recvmsg` and `sendmsg` on the socket. That is the only part that needs C, because Node.js sockets cannot pass file descriptors. The rest is a byte relay, and it runs in its own process, so a protocol bug cannot take the app down.

### Which compositors

A drag follows the pointer only where the compositor arranges a layer surface on the commit that carries the new margin. Nothing in the protocol reports this, so the list is measured, not reasoned: `niri`, `sway` and `river`. Other compositors stay on ordinary windows. `AIRI_LAYER_SHELL=1` tries one, and `0` turns the feature off.

## Consequences

- The app starts one more process, and on Wayland it starts twice: the first process only starts the proxy and the second one runs the app.
- A window on a layer surface cannot move to another display. The app must create it again there.
- A compositor-side resize is ignored, because the layer size belongs to the app.
- Only windows with a `-webkit-app-region: drag` area can be dragged.
- `koffi` is a new runtime dependency. It ships prebuilt binaries.
