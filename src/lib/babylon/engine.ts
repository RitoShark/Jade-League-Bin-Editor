/**
 * Tiny Babylon `Engine` factory.
 *
 * Originally tried a singleton-engine + many-views pattern, but Babylon's
 * multi-view extension (`engine.registerView`) needs a side-effect import
 * to graft itself onto the prototype, and the underlying WebGL context
 * still has to be bound to a real, visible canvas at construction time.
 * Trying to host one engine on a hidden 1×1 canvas and `registerView`
 * the visible canvases blew up with "registerView is not a function" on
 * Babylon 9.5.
 *
 * The simpler design: each preview component owns its own Engine + Scene,
 * attached to its visible canvas. Browsers cap active WebGL contexts at
 * ~16, but we only ever have 1-2 previews mounted at once (the main
 * preview pane + occasionally a hover preview), so the cap is moot.
 * Engine + scene get disposed on unmount.
 *
 * If we ever need cross-preview resource sharing (shader caches, texture
 * pools), revisit — likely via Babylon's `EngineFactory` + a true
 * registerView setup. Until then, simple wins.
 */

import { Engine } from '@babylonjs/core/Engines/engine';

export function createEngine(canvas: HTMLCanvasElement): Engine {
    return new Engine(canvas, true, {
        preserveDrawingBuffer: false,
        stencil: false,
        antialias: true,
        adaptToDeviceRatio: true,
        // Transparent backbuffer so the parent div's CSS background
        // (themed via --editor-bg) shows through. Avoids re-reading
        // and parsing CSS variables on every theme switch — the
        // rendering surface just becomes see-through and lets the
        // page handle background painting.
        alpha: true,
        premultipliedAlpha: false,
    });
}

// ── App-visibility gate ──────────────────────────────────────────
//
// Babylon's `runRenderLoop` runs at vsync regardless of whether the
// OS window is visible. With three+ engines active (Photo Studio +
// two Anim Studio viewports, sometimes four with the Bone Rig panel)
// that's a constant GPU draw even while the app is minimised.
//
// What we want: render whenever the Jade window is on-screen in any
// capacity (focused, behind another window, partly occluded — all
// fine). Stop rendering only when the window is fully hidden
// (minimised to taskbar, OS-level "show desktop", or a webview tab
// swap during dev).
//
// Tauri's webview keeps `document.visibilityState` stuck on
// 'visible' even when the OS window is minimised, so we can't rely
// on that alone. And `tauri://blur` fires for any focus change —
// including the user clicking into Discord / a browser docked
// alongside Jade — which is too aggressive (the user can still SEE
// the Jade viewport, they just clicked elsewhere).
//
// So we use Tauri's minimise state directly:
//   - On init, poll `isMinimized()` to capture launch-into-tray.
//   - Listen to `tauri://resize` — minimising fires a resize on
//     Windows + Linux. Re-poll `isMinimized()` after each event.
//   - `document.visibilityState` is kept as a fallback for the dev
//     server in a plain browser tab.

let _appVisible = typeof document === 'undefined'
    ? true
    : document.visibilityState === 'visible';

if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
        _appVisible = document.visibilityState === 'visible';
    });
}

// Tauri window-state listener. Dynamically imported so the module
// still works under jsdom / a plain browser dev server.
//
// `tauri://resize` is the obvious trigger — and DOES fire on
// minimise on Windows + Linux — but doesn't fire consistently on
// macOS. `tauri://blur` is more reliable: any window-state change
// that causes the OS to take focus away (minimise, switch space,
// hide app, etc.) emits blur. We poll `isMinimized()` from BOTH
// events so neither platform falls through.
//
// Note: we don't mark the window hidden directly from `blur` —
// that's too aggressive and would freeze rendering when the user
// just clicks into Discord / a browser docked next to Jade. We
// only flip `_appVisible` to false when the window is *actually*
// minimised per `isMinimized()`. Focused-but-not-on-top is still
// rendered.
if (typeof window !== 'undefined') {
    (async () => {
        try {
            const mod = await import('@tauri-apps/api/window');
            const w = mod.getCurrentWindow();
            const refresh = async () => {
                try {
                    const minimised = await w.isMinimized();
                    _appVisible = !minimised;
                } catch {
                    // Tauri API call failed — leave _appVisible alone.
                }
            };
            // Initial state (catches restart-into-tray etc.)
            await refresh();
            await w.listen('tauri://resize', () => { void refresh(); });
            await w.listen('tauri://blur', () => { void refresh(); });
            await w.listen('tauri://focus', () => { void refresh(); });
        } catch {
            // Not running under Tauri.
        }
    })();
}

/** True when the app's webview/window is on-screen and worth
 *  rendering for. Render loops should `if (!isAppVisible()) return;`
 *  at their entry to skip the per-frame Babylon work. Cheap to call
 *  (single boolean read). */
export function isAppVisible(): boolean {
    return _appVisible;
}
