# `@proj-airi/electron-wayland-layer-shell`

Makes selected Electron windows real Wayland layer surfaces on compositors that implement `zwlr_layer_shell_v1`.

## What it does

A layer surface is placed by the compositor, not by a window manager. It sits in a layer that fullscreen windows cannot cover. It has no title bar, no taskbar entry, and no tiling. That is what a desktop character or an overlay wants.

Chromium cannot create one. It speaks `xdg-shell` only, and the role of a `wl_surface` is fixed at its first commit. This package runs a small proxy between Electron and the compositor. The proxy replaces `xdg_surface.get_toplevel` with `zwlr_layer_shell_v1.get_layer_surface`, and it translates the events of both protocols. Chromium keeps using `xdg_toplevel`, and the compositor sees a layer surface.

## How it fits into the app

The proxy must run before Chromium connects to the compositor. Chromium picks its display backend and opens the Wayland socket before the main script runs, so a variable set in JavaScript is too late.

1. The launcher calls `ensureLayerShellProxy`. On Wayland, for a compositor that follows a drag, it starts the proxy and starts the app again with `WAYLAND_DISPLAY` pointing at the proxy. The first process then exits.
2. The main process connects to the proxy over a control socket and attaches each overlay window, with its window id and geometry, before it creates the `BrowserWindow`. The window title carries the window id so the proxy can name the window on the wire.
3. The proxy keeps the geometry. A drag or a resize becomes a change of margins and size, and the app gets the final geometry back so it can save it.

## Popups

A tooltip or a dropdown of an overlay window also becomes a layer surface. A popup must name a parent, and the parent of a converted window does not exist on the compositor, so the compositor would close the connection. The proxy places the popup in the overlay layer from the `xdg_positioner` values, then translates `configure` and `ack_configure` back to the popup protocol. A popup cannot grab the pointer, so a menu does not close when the user clicks outside of it.

## Window options

```ts
await manager.attach('main', { namespace: 'airi-pet', layer: 'overlay', keyboard: 'on-demand' }, geometry)
await manager.setGeometry('main', { x, y, width, height })
```

- `namespace` names the surface. The compositor shows it in its logs and rules.
- `layer` is `background`, `bottom`, `top` or `overlay`. Overlay is above fullscreen windows.
- `keyboard` is `none` or `on-demand`. `on-demand` gives the window the keyboard when the user clicks it, and never before.

## Limits

- A layer surface keeps the output it was created with. To move a window to another display, the app must create it again.
- The proxy clamps a drag to the output. A gesture that pushes past the edge stops there.
- The proxy reads the pointer position from its own events, so a gesture follows the pointer while it stays over the window.
- A popup gets no pointer grab. Clicking outside of an open menu does not close it.
- Chromium sends `xdg_toplevel.move` only for a `-webkit-app-region: drag` area. A window without one cannot be dragged.
- The proxy finds the output from the connector name in the Electron display label. When the label names no output, the compositor picks one and the margins point at the wrong screen.
- Only compositors measured to follow a drag are enabled by default: `niri`, `sway` and `river`. Set `AIRI_LAYER_SHELL=1` to try another one, or `0` to turn the feature off.

## Requirements

- Linux with a Wayland session, and a compositor that implements `zwlr_layer_shell_v1`.
- `koffi`. The proxy passes file descriptors between the app and the compositor, and Node.js sockets cannot do that.

## Where things live

| Path | Content |
| --- | --- |
| `src/index.ts` | Main-process side: proxy start, re-exec, `LayerShellManager` |
| `src/control.ts` | Control channel client |
| `src/options.ts` | Compositor policy and option checks |
| `src/protocol.ts` | Control messages and the title marker |
| `src/wire.ts` | Wayland wire format |
| `src/proxy/main.ts` | Proxy process: listeners, relay loop, control socket |
| `src/proxy/filter.ts` | Per-connection state machine: role conversion, shadowed requests, drag |
| `src/proxy/unix.ts` | `recvmsg` / `sendmsg` with `SCM_RIGHTS` through `koffi` |
