import { useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    House, File as LucideFile, FolderSearch, Aperture, CircleQuestionMark,
    FilePlus, Camera, Map as MapIcon, MousePointer2,
} from 'lucide-react';
import {
    EditIcon, ImageIcon, PencilIcon, SparklesIcon, LibraryIcon,
    PaletteIcon, SettingsIcon, HelpIcon, QuartzIcon,
} from './Icons';
import { applyTheme, applyModernUI } from '../lib/themeApplicator';
import { THEMES, SYNTAX_COLORS } from '../lib/themes';
import ThemeCard from './ThemeCard';
import { useShell } from '../shells/ShellContext';
import './GuideOverlay.css';

/** A single labelled row inside a step card — icon mirrors the actual
 *  UI element so the user can map the guide text to what they see. */
interface StepBodyItem { icon: ReactNode; label: string; desc: string; }
type StepBody = string | StepBodyItem[];

const ICON_SIZE = 16;

type GuideStep =
    | 'welcome'
    | 'rail'
    | 'quick-actions'
    | 'editor-prompt'
    | 'bin-tools'
    | 'find-dock'
    | 'right-buttons'
    | 'logo-prompt'
    | 'customize'
    | 'farewell';

const STEPS: GuideStep[] = [
    'welcome', 'rail', 'quick-actions', 'editor-prompt',
    'bin-tools', 'find-dock', 'right-buttons', 'logo-prompt',
    'customize', 'farewell',
];

// Steps that highlight multiple targets pass an array — the dim
// computes a union bounding box of all matched rects so every
// highlighted control falls inside the lit window, and a separate
// ring + click-through hole is rendered for each.
const STEP_SELECTORS: Partial<Record<GuideStep, string | string[]>> = {
    rail: '[data-guide-id="rail"]',
    'quick-actions': '[data-guide-id="quick-actions"]',
    'editor-prompt': '[data-guide-id="editor-brand"]',
    'bin-tools': '[data-guide-id="bin-tools"]',
    'find-dock': '[data-guide-id="find-btn"]',
    'right-buttons': '[data-guide-id="right-buttons"]',
    'logo-prompt': '[data-guide-id="logo"]',
};

const STEP_TITLES: Record<GuideStep, string> = {
    welcome: 'Welcome to Jade',
    rail: 'Navigation Rail',
    'quick-actions': 'Quick Actions',
    'editor-prompt': 'Open the Editor',
    'bin-tools': 'Editing Tools',
    'find-dock': 'Find Panel',
    'right-buttons': 'App Controls',
    'logo-prompt': 'Back to Home',
    customize: 'Style the app to your liking',
    farewell: "You're all set!",
};

/* Steps that describe several UI elements render an icon-labelled list
   (icon mirrors the real control); simple steps stay as prose. */
const STEP_BODY: Record<GuideStep, StepBody> = {
    welcome: '[PLACEHOLDER — replace with your welcome message]',
    rail: [
        { icon: <House size={ICON_SIZE} />, label: 'Home', desc: 'Back to the Home screen.' },
        { icon: <LucideFile size={ICON_SIZE} />, label: 'Open file', desc: 'Load a BIN (or other supported files) from disk.' },
        { icon: <FolderSearch size={ICON_SIZE} />, label: 'Extract Files', desc: 'Browse and unpack WAD archives.' },
        { icon: <Aperture size={ICON_SIZE} />, label: 'Viewer', desc: 'Preview champions 3D models and their assets.' },
        { icon: <CircleQuestionMark size={ICON_SIZE} />, label: 'About', desc: 'Learn more about Jade and submit feedback.' },
    ],
    'quick-actions': [
        { icon: <FilePlus size={ICON_SIZE} />, label: 'New file', desc: 'Create a new text or bin file.' },
        { icon: <LucideFile size={ICON_SIZE} />, label: 'Open file', desc: 'Browse for a file to open.' },
        { icon: <Camera size={ICON_SIZE} />, label: 'Photo Studio', desc: 'Stage models and export cool thumbnails.' },
        { icon: <LibraryIcon size={ICON_SIZE} />, label: 'Material Library', desc: 'Download and view materials from the library.' },
        { icon: <PaletteIcon size={ICON_SIZE} />, label: 'Themes', desc: 'Change the theme or customize the app.' },
        { icon: <SettingsIcon size={ICON_SIZE} />, label: 'Settings', desc: 'App settings and stuff.' },
    ],
    'editor-prompt': 'Click the Jade icon in the top-left to go to the editing workspace.',
    'bin-tools': [
        { icon: <EditIcon size={ICON_SIZE} />, label: 'General Editing', desc: 'Change or add some general stuff in the bin, settings for markdown files are this button.' },
        { icon: <ImageIcon size={ICON_SIZE} />, label: 'Texture Insert', desc: 'Insert texture links into the material override.' },
        { icon: <PencilIcon size={ICON_SIZE} />, label: 'Material Insert', desc: 'Insert material links into the override and insert materials downloaded from the library.' },
        { icon: <SparklesIcon size={ICON_SIZE} />, label: 'Particle Editing', desc: 'View particles and change some of their values.' },
        { icon: <MapIcon size={ICON_SIZE} />, label: 'Bin Navigation', desc: 'Navigate to different parts of a bin file.' },
        { icon: <LibraryIcon size={ICON_SIZE} />, label: 'Material Library', desc: 'You can download and view materials from here.' },
        { icon: <QuartzIcon size={ICON_SIZE} />, label: 'Send to Quartz', desc: 'Send the opened file to Quartz for editing.' },
    ],
    'find-dock': 'Click the Find button.\n\nThen drag its header and drop it onto the cross guide that appears - dock it anywhere you like. Dock it to the left to try it out.',
    'right-buttons': [
        { icon: <PaletteIcon size={ICON_SIZE} />, label: 'Themes', desc: 'Change the theme and customise stuff like syntax colors, fonts, background image, and effects.' },
        { icon: <PencilIcon size={ICON_SIZE} />, label: 'Preferences', desc: 'Some app preferences like saving xerox py files and syntax checking your bins.' },
        { icon: <SettingsIcon size={ICON_SIZE} />, label: 'Settings', desc: 'Options to manage hash files, how the app behaves, change performance options, and update the app.' },
        { icon: <HelpIcon size={ICON_SIZE} />, label: 'About', desc: 'Some info about the app, you can change the app icon and find links in here.' },
    ],
    'logo-prompt': 'Click the Jade icon in the top-left to return to the home screen at any time.',
    // `customize` is rendered by a dedicated CustomizeContent
    // sub-component (theme grid + .bin toggle + recent-files
    // slider), so this body string never gets shown — left here
    // only to satisfy the Record<GuideStep, …> exhaustiveness check.
    customize: '',
    farewell: 'Happy modding and editing from yours truly.\n You can restart this guide from the About menu.',
};

/* Gated steps: no Next button shown — user must take the action. */
const GATED_STEPS = new Set<GuideStep>(['editor-prompt', 'logo-prompt']);

/* Where the mascot sits per step — 'top' perches her on the card's top
   edge (~20% poking above), 'bottom' tucks her into the bottom-right
   corner peeking up. welcome/farewell render their own mascot. */
const MASCOT_PLACEMENT: Record<GuideStep, 'top' | 'bottom'> = {
    welcome: 'top',
    rail: 'top',
    'quick-actions': 'bottom',
    'editor-prompt': 'top',
    'bin-tools': 'top',
    'find-dock': 'top',
    'right-buttons': 'bottom',
    'logo-prompt': 'bottom',
    customize: 'top',
    farewell: 'top',
};

/* localStorage key the VS shell persists its dock layout under — the
   guide watches this to detect the user re-docking the Find panel. */
const DOCK_LAYOUT_KEY = 'vs-tool-layout';
/* Seconds the find-dock Next button stays disabled, nudging the user
   to actually try the drag-dock before moving on. */
const FIND_COOLDOWN_SECS = 5;

// Welcome step's hand-picked trio + the full set for the customize grid.
// Cards render via the shared <ThemeCard> (see ThemeCard.tsx), which
// derives its colors from THEMES + SYNTAX_COLORS.
const THEME_PREVIEW_IDS = ['Default', 'DarkBlue', 'AMOLED'];
const ALL_THEME_IDS = THEMES.map(t => t.id);

interface SpotRect { top: number; left: number; width: number; height: number; }

/** Compute the dim-cell rectangles that should be painted to dim
 *  everything in the viewport EXCEPT the supplied highlight rects.
 *  Algorithm: collect unique X and Y coords from the viewport edges
 *  + each highlight's edges, then walk the resulting grid. Each cell
 *  whose center isn't inside any highlight becomes a dim div; cells
 *  inside a highlight are skipped (= naturally lit + click-through).
 *  Returns ~`(N×2+1)² − N` cells for N rects — plenty cheap. */
function computeDimCells(rects: SpotRect[]): SpotRect[] {
    if (rects.length === 0) return [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const xs = new Set<number>([0, vw]);
    const ys = new Set<number>([0, vh]);
    for (const r of rects) {
        xs.add(r.left);
        xs.add(r.left + r.width);
        ys.add(r.top);
        ys.add(r.top + r.height);
    }
    const xa = [...xs].sort((a, b) => a - b);
    const ya = [...ys].sort((a, b) => a - b);
    const out: SpotRect[] = [];
    for (let i = 0; i < xa.length - 1; i++) {
        for (let j = 0; j < ya.length - 1; j++) {
            const x0 = xa[i];
            const x1 = xa[i + 1];
            const y0 = ya[j];
            const y1 = ya[j + 1];
            if (x1 <= x0 || y1 <= y0) continue;
            const cx = (x0 + x1) / 2;
            const cy = (y0 + y1) / 2;
            const insideHighlight = rects.some(
                (r) =>
                    cx >= r.left &&
                    cx <= r.left + r.width &&
                    cy >= r.top &&
                    cy <= r.top + r.height,
            );
            if (!insideHighlight) {
                out.push({ top: y0, left: x0, width: x1 - x0, height: y1 - y0 });
            }
        }
    }
    return out;
}

const MASCOT = '/media/Rare_Creation_Wisteria_Cake.webp';

interface GuideOverlayProps { onDone: () => void; }

export default function GuideOverlay({ onDone }: GuideOverlayProps) {
    const s = useShell();
    const [step, setStep] = useState<GuideStep>('welcome');
    // `spotRect` is the UNION bounding box used to compute the dim
    // and to anchor the guide card. `spotRects` is the per-element
    // list driving the highlight rings + click-through holes (one
    // per matched selector). For single-selector steps the list has
    // one entry and matches `spotRect` exactly.
    const [spotRect, setSpotRect] = useState<SpotRect | null>(null);
    const [spotRects, setSpotRects] = useState<SpotRect[]>([]);
    const [selectedTheme, setSelectedTheme] = useState('Default');
    // Tracks the live ModernUI preference. We mirror the Settings dialog's
    // behavior: MilkBag forces ModernUI off (its flat palette breaks under
    // glass), and `requiresModernUI` themes are unavailable while it's
    // off. We also remember the user's "preferred" value before MilkBag
    // forced it off so switching back restores their choice.
    const [modernUI, setModernUI] = useState(true);
    const modernUIBeforeMilkBagRef = useRef<boolean | null>(null);
    const [showSkipConfirm, setShowSkipConfirm] = useState(false);
    const [findCooldown, setFindCooldown] = useState(0);
    // Y of the editor body's top edge — used by find-dock phase B to
    // block just the top chrome (toolbar) while leaving the editor +
    // Find panel free to drag-dock.
    const [chromeBottom, setChromeBottom] = useState(120);
    const measureTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevWelcomeOverride = useRef(s.welcomeOverride);

    const stepIndex = STEPS.indexOf(step);
    const isGated = GATED_STEPS.has(step);
    // find-dock has two phases:
    //   A — Find not open yet: dim everything, Find button cut out.
    //   B — Find open: block only the top chrome so the user can grab
    //       the Find panel and drag it onto the dock cross.
    const findDockPhaseA = step === 'find-dock' && !s.findWidgetOpen;
    const findDockPhaseB = step === 'find-dock' && s.findWidgetOpen;
    // Steps whose spotlight hole stays clickable: gated prompts + the
    // find-dock step before Find is open (so the Find button works).
    const holeOpen = isGated || findDockPhaseA;

    const advance = useCallback(() => {
        setStep(prev => {
            const i = STEPS.indexOf(prev);
            return i < STEPS.length - 1 ? STEPS[i + 1] : prev;
        });
    }, []);

    const measureTarget = useCallback((currentStep: GuideStep) => {
        const sel = STEP_SELECTORS[currentStep];
        if (!sel) {
            setSpotRect(null);
            setSpotRects([]);
            return;
        }
        const selectors = Array.isArray(sel) ? sel : [sel];
        const rects: SpotRect[] = [];
        for (const s of selectors) {
            const el = document.querySelector(s);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            rects.push({ top: r.top, left: r.left, width: r.width, height: r.height });
        }
        if (rects.length === 0) {
            setSpotRect(null);
            setSpotRects([]);
            return;
        }
        // Union bounding box of every matched rect — the dim mask /
        // card-anchor reads from this single rect.
        let top = rects[0].top, left = rects[0].left;
        let right = rects[0].left + rects[0].width;
        let bottom = rects[0].top + rects[0].height;
        for (const r of rects) {
            if (r.top < top) top = r.top;
            if (r.left < left) left = r.left;
            if (r.left + r.width > right) right = r.left + r.width;
            if (r.top + r.height > bottom) bottom = r.top + r.height;
        }
        setSpotRect({ top, left, width: right - left, height: bottom - top });
        setSpotRects(rects);
    }, []);

    useEffect(() => {
        if (measureTimer.current) clearTimeout(measureTimer.current);
        measureTimer.current = setTimeout(() => measureTarget(step), 180);
        return () => { if (measureTimer.current) clearTimeout(measureTimer.current); };
    }, [step, measureTarget]);

    // Mirror the current ModernUI preference into local state — used by
    // the customize step to gray out themes that require Modern UI and
    // to force-toggle when MilkBag is selected.
    useEffect(() => {
        invoke<string>('get_preference', { key: 'ModernUI', defaultValue: 'true' })
            .then(v => setModernUI(v !== 'false'))
            .catch(() => {});
    }, []);

    useEffect(() => {
        const handler = () => measureTarget(step);
        window.addEventListener('resize', handler);
        return () => window.removeEventListener('resize', handler);
    }, [step, measureTarget]);

    /* Detect editor-prompt: user clicked the Editor button */
    useEffect(() => {
        const prev = prevWelcomeOverride.current;
        prevWelcomeOverride.current = s.welcomeOverride;
        if (step === 'editor-prompt' && s.welcomeOverride === 'hide' && prev !== 'hide') {
            setTimeout(advance, 300);
        }
    }, [s.welcomeOverride, step, advance]);

    /* Detect logo-prompt: user clicked the logo → welcome returns */
    useEffect(() => {
        if (step === 'logo-prompt' && s.welcomeOverride === 'force') {
            setTimeout(advance, 300);
        }
    }, [s.welcomeOverride, step, advance]);

    /* On guide start, close the Find panel if it was already open — the
       find-dock step needs a fresh "click Find" from the user. */
    useEffect(() => {
        if (s.findWidgetOpen) s.onFind();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /* find-dock phase B: keep the editor body's top edge measured so the
       chrome-blocking strip tracks the toolbar height. */
    useEffect(() => {
        if (step !== 'find-dock') return;
        const measure = () => {
            const body = document.querySelector('.vs-shell-body');
            setChromeBottom(body ? Math.round(body.getBoundingClientRect().top) : 120);
        };
        measure();
        window.addEventListener('resize', measure);
        // Re-measure as Find opens (the toolbar can reflow slightly).
        const t = setInterval(measure, 700);
        return () => { window.removeEventListener('resize', measure); clearInterval(t); };
    }, [step]);

    /* find-dock: run the Next-button cooldown AND watch the persisted
       dock layout. Only a genuine *re-dock* counts — the `find` entry
       must still be `kind: 'dock'` AND have moved to a different
       side/group. A drag that's dropped into a float (missed the dock
       cross) leaves `kind: 'float'`, which is deliberately ignored.
       No hard lock — the Next button still unlocks after the cooldown. */
    useEffect(() => {
        if (step !== 'find-dock') return;
        setFindCooldown(FIND_COOLDOWN_SECS);
        const cd = setInterval(() => {
            setFindCooldown(c => Math.max(0, c - 1));
        }, 1000);

        /** Find's dock placement as `side/group`, or null when it's not
         *  docked (floating / missing). */
        const readFindDock = (): string | null => {
            try {
                const f = JSON.parse(localStorage.getItem(DOCK_LAYOUT_KEY) || '{}').find;
                return f && f.kind === 'dock' ? `${f.side}/${f.group}` : null;
            } catch { return null; }
        };
        const baseline = readFindDock();
        const poll = setInterval(() => {
            const cur = readFindDock();
            // Advance only on a real dock landing somewhere new.
            if (cur && cur !== baseline) {
                clearInterval(poll);
                advance();
            }
        }, 600);

        return () => { clearInterval(cd); clearInterval(poll); };
    }, [step, advance]);

    const handleThemeSelect = (themeId: string) => {
        const target = THEMES.find(t => t.id === themeId);
        // Block themes that require Modern UI when it's currently off.
        // The UI also disables them, this is belt-and-suspenders.
        if (target?.requiresModernUI && !modernUI) return;

        // MilkBag forces ModernUI off (its flat palette breaks under
        // glass + gradients). Remember the prior value so switching
        // away restores the user's actual preference.
        const wasMilkBag = selectedTheme === 'MilkBag';
        const isMilkBag = themeId === 'MilkBag';
        if (isMilkBag && !wasMilkBag) {
            modernUIBeforeMilkBagRef.current = modernUI;
            if (modernUI) {
                applyModernUI(false);
                setModernUI(false);
                invoke('set_preference', { key: 'ModernUI', value: 'false' }).catch(() => {});
            }
        } else if (!isMilkBag && wasMilkBag) {
            const restore = modernUIBeforeMilkBagRef.current;
            if (restore === true && !modernUI) {
                applyModernUI(true);
                setModernUI(true);
                invoke('set_preference', { key: 'ModernUI', value: 'true' }).catch(() => {});
            }
            modernUIBeforeMilkBagRef.current = null;
        }

        applyTheme(themeId);
        // Settings pairs the syntax theme with the UI theme by default
        // (handleThemeSelect in ThemesDialog does the same when the
        // user hasn't enabled `OverrideSyntax`). Mirror that here so
        // the editor's syntax colors update immediately and stay in
        // sync after the guide finishes.
        const syn = SYNTAX_COLORS[themeId] ?? SYNTAX_COLORS.Default;
        const root = document.documentElement.style;
        root.setProperty('--syntax-keyword-color', syn.keyword);
        root.setProperty('--syntax-comment-color', syn.comment);
        root.setProperty('--syntax-string-color', syn.stringColor);
        root.setProperty('--syntax-number-color', syn.number);
        root.setProperty('--syntax-property-color', syn.propertyColor);
        invoke('set_preference', { key: 'SyntaxTheme', value: themeId }).catch(() => {});
        invoke('set_preference', { key: 'UseCustomSyntaxTheme', value: 'false' }).catch(() => {});
        invoke('set_preference', { key: 'OverrideSyntax', value: 'false' }).catch(() => {});
        setSelectedTheme(themeId);
    };

    // Persist GuideCompleted as soon as the user advances past the
    // welcome step. Rationale: re-showing the guide after they've
    // started it is more annoying than missing the last few steps if
    // they close the app mid-tour. Restarting from Help → About is
    // always available. The previous "only persist on farewell"
    // policy caused the guide to re-appear for anyone who quit
    // before reaching the end — which is what we were seeing in the
    // wild. The write is fire-and-forget; an explicit second write
    // happens on farewell / skip as belt-and-suspenders.
    const markGuideCompleted = () => {
        invoke('set_preference', { key: 'GuideCompleted', value: 'True' })
            .catch(e => console.warn('[guide] persist GuideCompleted failed:', e));
    };

    const handleNext = async () => {
        if (step === 'welcome' || step === 'customize') {
            await invoke('set_preference', { key: 'Theme', value: selectedTheme });
            await invoke('set_preference', { key: 'UseCustomTheme', value: 'false' });
        }
        // First advance past welcome — they've seen it; stamp now.
        if (step === 'welcome') markGuideCompleted();
        if (step === 'farewell') {
            markGuideCompleted();
            onDone();
            return;
        }
        advance();
    };

    const handleSkipConfirm = async () => {
        markGuideCompleted();
        onDone();
    };

    /* Card positioning */
    const CARD_W = 370;
    const CARD_H_EST = 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 16;

    let cardStyle: React.CSSProperties;
    const mascotPlacement = MASCOT_PLACEMENT[step];
    // 'top'-placed mascot pokes ~30px above the card, so those cards
    // can't start right at the screen edge; 'bottom' needs no headroom.
    const MASCOT_HEADROOM = mascotPlacement === 'top' ? 44 : 8;
    // Mirror the mascot for cards on the right half of the screen so
    // her tail always trails toward the nearer edge.
    let mascotMirror = false;

    if (!spotRect || step === 'welcome' || step === 'farewell' || step === 'customize') {
        cardStyle = {
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: step === 'customize' ? 640 : step === 'welcome' ? 500 : CARD_W,
        };
    } else {
        const rightFits = spotRect.left + spotRect.width + GAP + CARD_W < vw - 8;
        const leftFits = spotRect.left - GAP - CARD_W > 8;
        let top = Math.max(MASCOT_HEADROOM, Math.min(spotRect.top, vh - CARD_H_EST - 8));
        let left: number;

        if (rightFits) {
            left = spotRect.left + spotRect.width + GAP;
        } else if (leftFits) {
            left = spotRect.left - GAP - CARD_W;
        } else {
            top = Math.max(MASCOT_HEADROOM, Math.min(spotRect.top + spotRect.height + GAP, vh - CARD_H_EST - 8));
            left = Math.max(8, Math.min(spotRect.left + spotRect.width / 2 - CARD_W / 2, vw - CARD_W - 8));
        }

        mascotMirror = left + CARD_W / 2 > vw / 2;
        cardStyle = { position: 'fixed', top, left, width: CARD_W };
    }

    // `hasDim` — full dim + click-block the app. Off for welcome /
    // farewell (own card, no target) and for find-dock phase B (which
    // uses a chrome-only block instead so the editor stays draggable).
    const hasDim = step !== 'welcome' && step !== 'farewell' && !findDockPhaseB;
    // Highlight ring is shown whenever there's a target.
    const showRing = !!spotRect && step !== 'welcome' && step !== 'farewell';

    return (
        <div className="guide-overlay">
            {/* Dim. Rectangle-subtraction approach for ANY number of
                highlights: slice the viewport along every rect edge,
                emit a `.guide-dim` div for every cell whose center
                isn't inside one of the highlight rects. Cells that
                ARE inside a highlight get no dim div → those areas
                stay clickable (the highlighted buttons receive
                events normally). Beats the SVG-mask approach because
                each dim is a real DOM element with `pointer-events:
                all`, which Chromium handles consistently, vs SVG
                `visiblePainted` which falls apart inside `<mask>`. */}
            {hasDim && spotRects.length > 0 && computeDimCells(spotRects).map((c, i) => (
                <div
                    key={i}
                    className="guide-dim"
                    style={{ top: c.top, left: c.left, width: c.width, height: c.height }}
                />
            ))}
            {hasDim && spotRects.length === 0 && (
                <div className="guide-dim" style={{ position: 'fixed', inset: 0 }} />
            )}

            {/* find-dock phase B: block ONLY the top chrome (toolbar) so
                the user can't fire other tools, while leaving the editor
                body + Find panel free to grab and drag onto the cross. */}
            {findDockPhaseB && (
                <div className="guide-dim" style={{ top: 0, left: 0, right: 0, height: chromeBottom }} />
            )}

            {/* Highlight ring(s) — visual only, never blocks. One per
                matched target, so multi-selector steps (e.g. the
                Editor prompt now highlights both the rail button AND
                the top-left brand shortcut) get separate rings. */}
            {showRing && spotRects.map((r, i) => (
                <div
                    key={i}
                    className="guide-spotlight"
                    style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
                />
            ))}

            {/* On info steps, also block clicks INSIDE the spotlight —
                the element is only being explained, not used, so the
                user can't click through it and wander off. Steps with
                an open hole (gated prompts + find-dock-before-open)
                skip this so the highlighted control still works.
                Per-rect so each highlighted element is independently
                blocked. */}
            {hasDim && !holeOpen && spotRects.map((r, i) => (
                <div
                    key={i}
                    className="guide-hole-block"
                    style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
                />
            ))}

            {/* Welcome / farewell have no dim backdrop — still seal off
                the app behind so nothing is clickable but the card. */}
            {!hasDim && !findDockPhaseB && <div className="guide-fullblock" />}

            {/* Guide card */}
            <div
                className={`guide-card${step === 'customize' ? ' guide-card-wide' : ''}`}
                style={cardStyle}
            >
                {step !== 'welcome' && step !== 'farewell' && (
                    <div className="guide-step-label">Step {stepIndex} of {STEPS.length - 2}</div>
                )}

                {step === 'welcome' ? (
                    <WelcomeContent
                        selectedTheme={selectedTheme}
                        onThemeSelect={handleThemeSelect}
                        onNext={handleNext}
                    />
                ) : step === 'customize' ? (
                    <CustomizeContent
                        selectedTheme={selectedTheme}
                        onThemeSelect={handleThemeSelect}
                        onNext={handleNext}
                        modernUI={modernUI}
                    />
                ) : step === 'farewell' ? (
                    <FarewellContent onDone={handleNext} />
                ) : (
                    <StepContent
                        step={step}
                        isGated={isGated}
                        mirror={mascotMirror}
                        placement={mascotPlacement}
                        cooldown={step === 'find-dock' ? findCooldown : 0}
                        onNext={handleNext}
                    />
                )}
            </div>

            {/* Skip guide button — subtle, bottom-right */}
            {!showSkipConfirm && step !== 'farewell' && (
                <button className="guide-skip-btn" onClick={() => setShowSkipConfirm(true)}>
                    Skip guide
                </button>
            )}

            {/* Skip confirmation */}
            {showSkipConfirm && (
                <div className="guide-skip-confirm">
                    <div className="guide-skip-confirm-card">
                        <p>Skip the guide?</p>
                        <p className="guide-skip-confirm-sub">You can restart it anytime from Help → About.</p>
                        <div className="guide-skip-confirm-btns">
                            <button className="guide-skip-confirm-no" onClick={() => setShowSkipConfirm(false)}>Keep going</button>
                            <button className="guide-skip-confirm-yes" onClick={handleSkipConfirm}>Skip</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

/* ── Sub-components ───────────────────────────────────────────────── */

function WelcomeContent({ selectedTheme, onThemeSelect, onNext }: {
    selectedTheme: string;
    onThemeSelect: (id: string) => void;
    onNext: () => void;
}) {
    return (
        <>
            <div className="guide-welcome-header">
                <img src={MASCOT} alt="" className="guide-welcome-mascot" draggable={false} />
                <div>
                    <h2 className="guide-welcome-title">Welcome to Jade</h2>
                    <p className="guide-welcome-sub">Jade is a modding tool with many features, this guide will walk you through the basics of the app and it's layout.</p>
                </div>
            </div>

            <div className="guide-theme-label">Choose a look</div>

            <div className="guide-theme-row">
                {THEME_PREVIEW_IDS.map(id => (
                    <ThemeCard
                        key={id}
                        themeId={id}
                        selected={selectedTheme === id}
                        onClick={() => onThemeSelect(id)}
                    />
                ))}
            </div>

            <p className="guide-more-themes">More themes in the Themes menu and at the guide's end.</p>

            <div className="guide-card-actions">
                <button className="guide-card-next" onClick={onNext}>Next</button>
            </div>
        </>
    );
}

function CustomizeContent({ selectedTheme, onThemeSelect, onNext, modernUI }: {
    selectedTheme: string;
    onThemeSelect: (id: string) => void;
    onNext: () => void;
    /** Current ModernUI preference. When false, themes flagged with
     *  `requiresModernUI` (2077, 2023, YoRHa, Lain) render disabled. */
    modernUI: boolean;
}) {
    const [binRegistered, setBinRegistered] = useState<boolean>(false);
    const [binBusy, setBinBusy] = useState<boolean>(false);
    const [recentLimit, setRecentLimit] = useState<number>(10);

    // Load initial values once on mount.
    useEffect(() => {
        (async () => {
            try {
                const reg = await invoke<boolean>('get_bin_association_status');
                setBinRegistered(!!reg);
            } catch { /* noop */ }
            try {
                const raw = await invoke<string>('get_preference', {
                    key: 'RecentFilesLimit', defaultValue: '10',
                });
                const n = parseInt(raw);
                setRecentLimit(Number.isFinite(n) && n > 0 ? Math.min(n, 50) : 10);
            } catch { /* noop */ }
        })();
    }, []);

    const toggleBin = async () => {
        if (binBusy) return;
        setBinBusy(true);
        try {
            const cmd = binRegistered ? 'unregister_bin_association' : 'register_bin_association';
            await invoke(cmd);
            setBinRegistered(!binRegistered);
        } catch (e) {
            console.warn('[guide] bin association toggle failed:', e);
        } finally {
            setBinBusy(false);
        }
    };

    const saveRecentLimit = async (n: number) => {
        setRecentLimit(n);
        try {
            await invoke('set_preference', { key: 'RecentFilesLimit', value: String(n) });
        } catch (e) {
            console.warn('[guide] recent-limit save failed:', e);
        }
    };

    return (
        <>
            <h3 className="guide-card-title">{STEP_TITLES.customize}</h3>
            <p className="guide-card-body">
                A few quick choices so Jade fits your liking.
            </p>

            <div className="guide-customize-section-label">Theme</div>
            <div className="guide-customize-theme-grid">
                {ALL_THEME_IDS.map(id => {
                    // Themes that depend on Modern UI's glass + gradient
                    // layer can't render meaningfully without it — disable
                    // them when Modern UI is currently off (e.g. because
                    // the user has MilkBag selected, which forces it off).
                    const themeMeta = THEMES.find(th => th.id === id);
                    const lockedByModern = !!themeMeta?.requiresModernUI && !modernUI;
                    return (
                        <ThemeCard
                            key={id}
                            themeId={id}
                            selected={selectedTheme === id}
                            locked={lockedByModern}
                            title={lockedByModern ? `${themeMeta?.displayName} — requires Modern UI` : undefined}
                            onClick={() => onThemeSelect(id)}
                        />
                    );
                })}
            </div>

            <div className="guide-customize-bottom">
                <div className="guide-customize-bottom-col">
                    <div className="guide-customize-section-label">.bin file association</div>
                    <div className="guide-customize-row">
                        <p className="guide-customize-row-desc">
                            {binRegistered
                                ? 'Already registered, double-clicking a .bin opens it in Jade.'
                                : 'Make Jade the default app for .bin files.'}
                        </p>
                        <button
                            type="button"
                            className={`guide-customize-toggle${binRegistered ? ' on' : ''}`}
                            onClick={toggleBin}
                            disabled={binBusy || binRegistered}
                            title={binRegistered ? 'Unregister from Settings -> File associations' : undefined}
                        >
                            {binBusy ? '…' : binRegistered ? 'Registered' : 'Register'}
                        </button>
                    </div>
                </div>

                <div className="guide-customize-bottom-col">
                    <div className="guide-customize-section-label">Recent files to remember</div>
                    <div className="guide-customize-slider-row">
                        <input
                            type="range"
                            min={1}
                            max={50}
                            step={1}
                            value={recentLimit}
                            onChange={(e) => saveRecentLimit(parseInt(e.target.value))}
                            className="guide-customize-slider"
                        />
                        <span className="guide-customize-slider-value">{recentLimit}</span>
                    </div>
                </div>
            </div>

            <div className="guide-card-actions">
                <button className="guide-card-next" onClick={onNext}>Next</button>
            </div>

            {/* Mascot perched top-right. The customize card is wider
                than the info-step cards, so she gets a bigger, slightly
                inset variant via `.customize` so she doesn't look tiny
                relative to the card. */}
            <img
                src={MASCOT}
                alt=""
                className="guide-step-mascot top customize mirror"
                draggable={false}
            />
        </>
    );
}

function FarewellContent({ onDone }: { onDone: () => void }) {
    return (
        <>
            <div className="guide-farewell-mascot-wrap">
                <img src={MASCOT} alt="" className="guide-farewell-mascot" draggable={false} />
            </div>
            <h3 className="guide-card-title">{STEP_TITLES.farewell}</h3>
            {/* farewell body is always prose — cast narrows the union. */}
            <p className="guide-card-body">{STEP_BODY.farewell as string}</p>
            <div className="guide-card-actions">
                <button className="guide-card-next" onClick={onDone}>Thanks!</button>
            </div>
        </>
    );
}

function StepContent({ step, isGated, mirror, placement, cooldown, onNext }: {
    step: GuideStep;
    isGated: boolean;
    /** Flip the mascot for cards sitting on the right half of the screen. */
    mirror: boolean;
    /** 'top' = perched on the card's top edge, 'bottom' = corner peek. */
    placement: 'top' | 'bottom';
    /** Seconds the Next button stays disabled (find-dock nudge); 0 = ready. */
    cooldown: number;
    onNext: () => void;
}) {
    const body = STEP_BODY[step];
    return (
        <>
            <h3 className="guide-card-title">{STEP_TITLES[step]}</h3>

            {typeof body === 'string' ? (
                <p className="guide-card-body">{body}</p>
            ) : (
                <ul className="guide-step-list">
                    {body.map(item => (
                        <li className="guide-step-list-item" key={item.label}>
                            <span className="guide-step-list-icon">{item.icon}</span>
                            <span className="guide-step-list-text">
                                <span className="guide-step-list-label">{item.label}</span>
                                <span className="guide-step-list-desc">{item.desc}</span>
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            {/* Looping drag hint — a tab header is grabbed by the cursor
                and dragged onto a dock-guide target (the target mirrors
                the real VS dock-guide glyph). Stepped animation keeps it
                light (~30fps). */}
            {step === 'find-dock' && (
                <div className="guide-drag-hint" aria-hidden="true">
                    {/* Dock target — same glyph the real dock cross uses. */}
                    <span className="guide-drag-hint-target">
                        <svg width="28" height="28" viewBox="0 0 16 16">
                            <rect x="0.6" y="0.6" width="14.8" height="14.8" rx="1.2"
                                fill="none" stroke="currentColor" strokeWidth="1" />
                            <rect x="10.6" y="1.2" width="4.2" height="13.6" rx="0.5"
                                fill="var(--jade-accent, #4a9870)" />
                            <polygon points="5,3.5 5,12.5 9.5,8"
                                fill="var(--jade-accent, #4a9870)" />
                        </svg>
                    </span>
                    {/* Dragged element — styled like a tab header strip. */}
                    <span className="guide-drag-hint-tab">
                        <span className="guide-drag-hint-tabtitle" />
                        <MousePointer2 size={17} className="guide-drag-hint-cursor" />
                    </span>
                </div>
            )}

            <div className="guide-card-actions">
                {isGated ? (
                    // The two editor / logo prompts intentionally have
                    // no skip-step affordance — the whole point of the
                    // guide is to walk the user through this exact
                    // round trip. Letting them skip would land them in
                    // a state (editor open or welcome forced) that the
                    // next step assumes they reached via the prompted
                    // gesture.
                    <span className="guide-card-waiting">Waiting for you…</span>
                ) : (
                    <button
                        className="guide-card-next"
                        onClick={onNext}
                        disabled={cooldown > 0}
                        title={cooldown > 0 ? 'Give the docking a try first' : undefined}
                    >
                        {cooldown > 0 ? `Next (${cooldown})` : 'Next'}
                    </button>
                )}
            </div>

            {/* Mascot — perched on the card's top edge or peeking from
                the bottom-right corner depending on the step. Mirrored
                for cards on the screen's right half so her tail trails
                toward the nearer edge. editor-prompt nudges her a bit
                higher than the other top-placed steps. */}
            <img
                src={MASCOT}
                alt=""
                className={`guide-step-mascot ${placement}${mirror ? ' mirror' : ''}`}
                draggable={false}
                style={step === 'editor-prompt' ? { top: -44 } : undefined}
            />
        </>
    );
}
