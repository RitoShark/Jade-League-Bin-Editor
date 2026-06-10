// Theme background effects — lightweight animated overlays that give the
// alternate themes more life. Effects render ONLY in Modern UI (they show
// through the translucent glass panels); in classic UI they're suppressed.
// Each alternate theme maps to one effect via `effect` in themes.ts; the
// Effects tab can override or disable it.

export interface ThemeEffect {
    id: string;
    displayName: string;
    description: string;
    /** false = placeholder slot with no renderer yet (selectable + previewable
     *  as "coming soon"; renders nothing live). */
    implemented: boolean;
}

export const THEME_EFFECTS: ThemeEffect[] = [
    { id: 'none',       displayName: 'None',       implemented: true,
      description: 'No background effect.' },
    { id: 'stars',      displayName: 'Starfield',  implemented: true,
      description: 'Slowly drifting, twinkling stars — a lightweight imitation of deep space.' },
    { id: 'petals',     displayName: 'Petals',     implemented: true,
      description: 'Cherry-blossom petals drifting down with a gentle sway.' },
    { id: 'snow',       displayName: 'Snow',       implemented: true,
      description: 'Soft frost motes falling slowly across the window.' },
    { id: 'fireflies',  displayName: 'Fireflies',  implemented: true,
      description: 'Fireflies wandering and pulsing in the dark.' },
    { id: 'storm',      displayName: 'Storm',      implemented: true,
      description: 'Heavy wind-driven rain — a stormier, more aggressive downpour.' },
    { id: 'embers',     displayName: 'Embers',     implemented: true,
      description: 'Embers and sparks rising and flickering from below.' },
    { id: 'rain',       displayName: 'Rain',       implemented: true,
      description: 'Soft rainfall streaking down the window.' },
];

export function getThemeEffect(id?: string): ThemeEffect | undefined {
    return THEME_EFFECTS.find(e => e.id === id);
}

/**
 * Resolve which effect should run, mirroring the syntax-theme resolution:
 * disabled → none; override on → the chosen id; otherwise the active theme's
 * own default effect. Placeholders collapse to 'none'. (Modern-UI gating is
 * applied separately, in the live layer, since it can change without a
 * re-resolve.)
 */
export function resolveEffectId(opts: {
    enabled: boolean;
    override: boolean;
    chosenId: string;
    themeEffect?: string;
}): string {
    if (!opts.enabled) return 'none';
    const id = opts.override ? opts.chosenId : (opts.themeEffect ?? 'none');
    const eff = getThemeEffect(id);
    return eff?.implemented ? id : 'none';
}

export interface EffectHandle { stop(): void; }

const NOOP_HANDLE: EffectHandle = { stop() { /* nothing */ } };
const TAU = Math.PI * 2;
const rand = (min: number, max: number) => Math.random() * (max - min) + min;

// Frames are vsync-paced — one render per requestAnimationFrame. Delta-time
// scaling keeps motion speed identical regardless of refresh rate. We do NOT
// skip frames to "cap" at 60: on a 60Hz display the skip threshold lands right
// on the frame boundary and jitter makes it alternate skip/double — which is
// what stuttered. Rendering every frame is smooth, and on 60Hz that is 60fps.
const FRAME_BASE = 1000 / 60;       // dt = 1 means "one 60fps frame's worth"

// Effects are soft and sit behind blur — rendering at 1× device pixels (not 2×
// retina) cuts the canvas pixel count up to 4× with no visible quality loss.
const EFFECT_DPR = 1;

/**
 * Run `render(dt)` once per animation frame (vsync-paced → smooth and tear-free;
 * 60fps on a 60Hz display). `dt` is the real time since the last frame in 60fps
 * units (≈1 per 60fps frame, clamped after a stall), so multiplying motion by dt
 * keeps speed constant on higher-refresh displays too — with no frame-skipping
 * to stutter.
 */
function rafLoop(render: (dt: number) => void): () => void {
    let running = true;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
        if (!running) return;
        raf = requestAnimationFrame(loop);
        const dt = last === 0 ? 1 : Math.min(3, (now - last) / FRAME_BASE);
        last = now;
        render(dt);
    };
    raf = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(raf); };
}

type Renderer = (canvas: HTMLCanvasElement, opts: { density: number }) => EffectHandle;

/** Size a canvas to its CSS box at EFFECT_DPR and return the CSS w/h. */
function fitCanvas(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): [number, number] {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.floor(w * EFFECT_DPR));
    canvas.height = Math.max(1, Math.floor(h * EFFECT_DPR));
    ctx.setTransform(EFFECT_DPR, 0, 0, EFFECT_DPR, 0, 0);
    return [w, h];
}

// ── Shared particle scaffold ────────────────────────────────────────────────
interface ParticleSpec<P> {
    densityDivisor: number;   // px² of canvas per particle
    cap: number;              // hard cap so huge monitors stay cheap
    composite?: GlobalCompositeOperation;
    spawn: (w: number, h: number) => P;
    step: (p: P, w: number, h: number, t: number, dt: number) => void;
    draw: (ctx: CanvasRenderingContext2D, p: P, t: number, w: number, h: number) => void;
}

function makeParticleRenderer<P>(spec: ParticleSpec<P>): Renderer {
    return (canvas, opts) => {
        const ctx = canvas.getContext('2d');
        if (!ctx) return NOOP_HANDLE;
        let w = 0;
        let h = 0;
        let parts: P[] = [];

        const rebuild = () => {
            [w, h] = fitCanvas(canvas, ctx);
            const count = Math.min(spec.cap, Math.round((w * h) / spec.densityDivisor * opts.density));
            parts = Array.from({ length: count }, () => spec.spawn(w, h));
        };

        const ro = new ResizeObserver(rebuild);
        ro.observe(canvas);
        rebuild();

        let t = 0;
        const stop = rafLoop((dt) => {
            t += 0.016 * dt;
            ctx.clearRect(0, 0, w, h);
            ctx.globalCompositeOperation = spec.composite ?? 'source-over';
            for (const p of parts) {
                spec.step(p, w, h, t, dt);
                spec.draw(ctx, p, t, w, h);
            }
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        });

        return { stop() { stop(); ro.disconnect(); } };
    };
}

// ── Starfield (Deep Space) ──────────────────────────────────────────────────
interface Star { x: number; y: number; r: number; a: number; tw: number; ph: number; vy: number; }
const stars = makeParticleRenderer<Star>({
    densityDivisor: 11000, cap: 220,
    spawn: (w, h) => ({ x: rand(0, w), y: rand(0, h), r: rand(0.3, 1.6), a: rand(0.3, 0.8), tw: rand(0.4, 1.9), ph: rand(0, TAU), vy: rand(0.01, 0.05) }),
    step: (p, w, h, _t, dt) => { p.y += p.vy * dt; if (p.y > h + 2) { p.y = -2; p.x = rand(0, w); } },
    draw: (ctx, p, t) => {
        const a = p.a * (0.55 + 0.45 * Math.sin(t * p.tw + p.ph));
        ctx.globalAlpha = a > 0 ? a : 0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    },
});

// ── Petals (Sakura Garden) ──────────────────────────────────────────────────
// Pale blossom pink — lighter than the mauve theme so they read by lightness
// contrast, but soft (the earlier deep rose was too punchy).
interface Petal { x: number; y: number; s: number; sp: number; sw: number; ph: number; rot: number; vr: number; }
const petals = makeParticleRenderer<Petal>({
    densityDivisor: 14000, cap: 110,
    spawn: (w, h) => ({ x: rand(0, w), y: rand(0, h), s: rand(3, 7), sp: rand(0.3, 0.8), sw: rand(0.4, 1.2), ph: rand(0, TAU), rot: rand(0, TAU), vr: rand(-0.03, 0.03) }),
    step: (p, w, h, t, dt) => { p.y += p.sp * dt; p.x += Math.sin(t * 0.8 + p.ph) * p.sw * 0.5 * dt; p.rot += p.vr * dt; if (p.y > h + p.s) { p.y = -p.s; p.x = rand(0, w); } },
    draw: (ctx, p) => {
        ctx.save();
        ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.globalAlpha = 0.82; ctx.fillStyle = '#F8B4DD';
        ctx.beginPath(); ctx.ellipse(0, 0, p.s, p.s * 0.55, 0, 0, TAU); ctx.fill();
        ctx.restore();
    },
});

// ── Snow / frost motes (Frost Lens) ─────────────────────────────────────────
interface Flake { x: number; y: number; r: number; sp: number; sw: number; ph: number; }
const snow = makeParticleRenderer<Flake>({
    densityDivisor: 9000, cap: 200,
    spawn: (w, h) => ({ x: rand(0, w), y: rand(0, h), r: rand(1, 3), sp: rand(0.25, 0.75), sw: rand(0.2, 0.8), ph: rand(0, TAU) }),
    step: (p, w, h, t, dt) => { p.y += p.sp * dt; p.x += Math.sin(t * 0.6 + p.ph) * p.sw * 0.3 * dt; if (p.y > h + p.r) { p.y = -p.r; p.x = rand(0, w); } },
    draw: (ctx, p) => {
        ctx.globalAlpha = 0.7; ctx.fillStyle = '#4E97CC';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    },
});

// ── Fireflies (Evergreen Hills) ─────────────────────────────────────────────
interface Fly { x: number; y: number; r: number; ph: number; phx: number; phy: number; tw: number; }
const fireflies = makeParticleRenderer<Fly>({
    densityDivisor: 16000, cap: 70, composite: 'lighter',
    spawn: (w, h) => ({ x: rand(0, w), y: rand(0, h), r: rand(1, 2.5), ph: rand(0, TAU), phx: rand(0, TAU), phy: rand(0, TAU), tw: rand(0.6, 1.8) }),
    step: (p, w, h, t, dt) => {
        p.x += Math.sin(t * 0.5 + p.phx) * 0.4 * dt;
        p.y += Math.cos(t * 0.4 + p.phy) * 0.3 * dt;
        if (p.x < 0) p.x += w; else if (p.x > w) p.x -= w;
        if (p.y < 0) p.y += h; else if (p.y > h) p.y -= h;
    },
    draw: (ctx, p, t) => {
        const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * p.tw + p.ph));
        ctx.fillStyle = '#CBE86A';
        ctx.globalAlpha = pulse * 0.22; ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3, 0, TAU); ctx.fill();
        ctx.globalAlpha = pulse;        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    },
});

// ── Embers (Autumn Ember) ───────────────────────────────────────────────────
interface Ember { x: number; y: number; r: number; sp: number; sw: number; ph: number; tw: number; }
const embers = makeParticleRenderer<Ember>({
    densityDivisor: 12000, cap: 110, composite: 'lighter',
    spawn: (w, h) => ({ x: rand(0, w), y: rand(0, h), r: rand(0.6, 2.2), sp: rand(0.3, 0.9), sw: rand(0.3, 0.9), ph: rand(0, TAU), tw: rand(2, 5) }),
    step: (p, w, h, t, dt) => { p.y -= p.sp * dt; p.x += Math.sin(t * 1.1 + p.ph) * p.sw * 0.5 * dt; if (p.y < -p.r) { p.y = h + p.r; p.x = rand(0, w); } },
    draw: (ctx, p, t, _w, h) => {
        const fade = Math.max(0, Math.min(1, p.y / (h || 1)));
        const flick = 0.6 + 0.4 * Math.sin(t * p.tw + p.ph);
        ctx.globalAlpha = fade * flick * 0.85;
        ctx.fillStyle = '#FF7A33';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
    },
});

// ── Rain (Orchid Origami) ───────────────────────────────────────────────────
interface Drop { x: number; y: number; len: number; sp: number; slant: number; }
const rain = makeParticleRenderer<Drop>({
    densityDivisor: 7000, cap: 260,
    spawn: (w, h) => ({ x: rand(0, w), y: rand(0, h), len: rand(8, 18), sp: rand(7, 13), slant: rand(0.8, 2.3) }),
    step: (p, w, h, _t, dt) => { p.y += p.sp * dt; p.x += p.slant * dt; if (p.y > h) { p.y = -p.len; p.x = rand(0, w); } else if (p.x > w) { p.x -= w; } },
    draw: (ctx, p) => {
        ctx.globalAlpha = 0.28; ctx.strokeStyle = '#C3B4E0'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.slant * 2, p.y - p.len); ctx.stroke();
    },
});

// ── Storm (Stormy Sea) ──────────────────────────────────────────────────────
// Wind-driven rain — denser, faster and far more slanted than Orchid's gentle
// drizzle, for a proper stormy downpour. Drops enter from the top-left band so
// the strong rightward wind keeps the whole window covered.
interface StormDrop { x: number; y: number; len: number; sp: number; slant: number; }
const storm = makeParticleRenderer<StormDrop>({
    densityDivisor: 5000, cap: 360,
    spawn: (w, h) => ({ x: rand(-h * 0.4, w), y: rand(0, h), len: rand(16, 32), sp: rand(13, 22), slant: rand(3.5, 6) }),
    step: (p, w, h, _t, dt) => {
        p.y += p.sp * dt; p.x += p.slant * dt;
        if (p.y > h || p.x > w) { p.y = -p.len; p.x = rand(-h * 0.4, w); }
    },
    draw: (ctx, p) => {
        ctx.globalAlpha = 0.34; ctx.strokeStyle = '#C2CBEE'; ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.slant * 2.2, p.y - p.len); ctx.stroke();
    },
});

/** Registry of live renderers. */
const RENDERERS: Record<string, Renderer> = {
    stars, petals, snow, fireflies, storm, embers, rain,
};

/**
 * Start an effect on a caller-owned canvas (used by the in-dialog preview).
 * Returns a handle to stop it; 'none' / unknown ids yield a no-op handle.
 */
export function startEffectOnCanvas(
    effectId: string,
    canvas: HTMLCanvasElement,
    opts?: { density?: number },
): EffectHandle {
    const renderer = RENDERERS[effectId];
    if (!renderer) return NOOP_HANDLE;
    return renderer(canvas, { density: opts?.density ?? 1 });
}

// ── Live app layer ──────────────────────────────────────────────────────────
// Owns a single <canvas> parked behind app content inside .app-container (see
// #jade-effect-layer in App.css). Effects render only in Modern UI; the gate
// reads data-ui-mode (the real, reconciled mode) so toggling Modern UI shows /
// hides them without a full theme re-apply (reconcileModernUI calls refresh).

const LAYER_ID = 'jade-effect-layer';
let liveHandle: EffectHandle | null = null;
let liveCleanup: (() => void) | null = null;
let mountToken = 0;
let requestedEffectId = 'none';
let welcomeOpen = false;
let editorEffectsEnabled = true;    // user pref: play effects in the editor
let welcomeEffectsEnabled = true;   // user pref: play effects on the welcome screen

function modernUIActive(): boolean {
    return document.documentElement.getAttribute('data-ui-mode') === 'modern';
}

/**
 * Drives <html data-theme-effect>, which ONLY the welcome screen's own canvas
 * reads (the editor layer uses `requestedEffectId` directly). Set when an
 * implemented effect is active in Modern UI AND the user wants effects on the
 * welcome screen — so toggling that preference, or which surface is up, never
 * disturbs the editor layer. Kept separate from the editor canvas's
 * mount/teardown so opening the welcome screen doesn't wipe it.
 */
function updateEffectAttribute() {
    const active = !!RENDERERS[requestedEffectId] && modernUIActive() && welcomeEffectsEnabled;
    if (active) document.documentElement.setAttribute('data-theme-effect', requestedEffectId);
    else document.documentElement.removeAttribute('data-theme-effect');
}

function teardownLive() {
    if (liveHandle) { liveHandle.stop(); liveHandle = null; }
    if (liveCleanup) { liveCleanup(); liveCleanup = null; }
    document.getElementById(LAYER_ID)?.remove();
}

function mountLive(effectId: string, renderer: Renderer, token: number, attempt: number) {
    if (token !== mountToken) return;                 // superseded
    const host = document.querySelector('.app-container');
    if (!host) {
        // .app-container may not be in the DOM yet on cold start — retry briefly.
        if (attempt < 40) requestAnimationFrame(() => mountLive(effectId, renderer, token, attempt + 1));
        return;
    }
    if (document.getElementById(LAYER_ID)) return;

    const canvas = document.createElement('canvas');
    canvas.id = LAYER_ID;
    host.appendChild(canvas);

    let handle = renderer(canvas, { density: 1 });
    liveHandle = handle;
    let paused = false;

    // Pause whenever the window is hidden OR unfocused — you only see the effect
    // when Jade is the focused window, so animating (and forcing the glass to
    // re-blur) while you're in another app is pure wasted GPU. Resume on return.
    const update = () => {
        if (token !== mountToken) return;
        const shouldRun = !document.hidden && document.hasFocus();
        if (shouldRun && paused) {
            handle = renderer(canvas, { density: 1 });
            liveHandle = handle;
            paused = false;
        } else if (!shouldRun && !paused) {
            handle.stop();
            paused = true;
        }
    };
    document.addEventListener('visibilitychange', update);
    window.addEventListener('blur', update);
    window.addEventListener('focus', update);
    liveCleanup = () => {
        document.removeEventListener('visibilitychange', update);
        window.removeEventListener('blur', update);
        window.removeEventListener('focus', update);
    };
    update();   // apply initial focus state (e.g. launched unfocused)
}

function renderLive() {
    teardownLive();
    const token = ++mountToken;
    const renderer = RENDERERS[requestedEffectId];
    // Skip when editor effects are off, or while the welcome screen is open (it
    // renders its own effect canvas, so the editor layer would just burn GPU
    // occluded behind it).
    if (!renderer || !modernUIActive() || welcomeOpen || !editorEffectsEnabled) return;
    mountLive(requestedEffectId, renderer, token, 0);
}

/**
 * Apply (or clear) the live background effect. Pass the already-resolved id
 * (see resolveEffectId). Suppressed automatically when Modern UI is off.
 */
export function applyLiveThemeEffect(effectId: string) {
    requestedEffectId = effectId;
    updateEffectAttribute();
    renderLive();
}

/**
 * Re-evaluate the live effect against the current Modern-UI state. Called from
 * reconcileModernUI so effects appear / disappear the instant Modern UI is
 * toggled, without a full theme re-apply.
 */
export function refreshLiveThemeEffect() {
    updateEffectAttribute();
    renderLive();
}

/**
 * Tell the editor layer whether the welcome screen is open. While it is, the
 * editor effect is torn down (the welcome screen renders its own canvas);
 * closing it brings the editor effect back.
 */
export function setEffectsWelcomeOpen(open: boolean) {
    if (welcomeOpen === open) return;
    welcomeOpen = open;
    renderLive();
}

/**
 * User preference: whether effects play in the editor. Off → the welcome screen
 * can still show them (independent toggle); the editor layer is torn down.
 */
export function setEffectsOnEditor(enabled: boolean) {
    if (editorEffectsEnabled === enabled) return;
    editorEffectsEnabled = enabled;
    renderLive();
}

/**
 * User preference: whether effects play on the welcome screen. Off → the editor
 * can still get effects (the editor layer doesn't read the attribute this gates).
 */
export function setEffectsOnWelcome(enabled: boolean) {
    if (welcomeEffectsEnabled === enabled) return;
    welcomeEffectsEnabled = enabled;
    updateEffectAttribute();
}
