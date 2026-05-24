import {
  ReactNode,
  useState,
  useEffect,
  useRef,
  useCallback,
  Children,
  isValidElement,
} from 'react';
import { ChevronDown, LucideIcon } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import './Accordion.css';

/**
 * Reusable accordion. First customer is the Viewer's right rail
 * (Information / Animations / Model Parts / Chromas / Options / Export).
 * Designed so it can later host BIN-editor or Studio side-panel content
 * with no changes — sections are independent and each persists its own
 * open/closed state via a preference key.
 */

interface AccordionProps {
  children: ReactNode;
  /** Optional className passthrough for layout (width, padding, …). */
  className?: string;
}

export function Accordion({ children, className }: AccordionProps) {
  return (
    <div className={`jade-accordion${className ? ` ${className}` : ''}`}>
      {Children.map(children, (c) => (isValidElement(c) ? c : null))}
    </div>
  );
}

interface AccordionSectionProps {
  /** Stable id — used as the preference key suffix when `prefKey` is set. */
  id: string;
  title: string;
  icon?: LucideIcon;
  /** Initial open state when no persisted value is found. */
  defaultOpen?: boolean;
  /** Right-side adornment in the header (e.g. a small badge / count). */
  trailing?: ReactNode;
  /** When given, open/closed state persists via `<prefKey>.<id>`. */
  prefKey?: string;
  children: ReactNode;
}

export function AccordionSection({
  id,
  title,
  icon: Icon,
  defaultOpen = false,
  trailing,
  prefKey,
  children,
}: AccordionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  // Loaded state from the preference store. Until this resolves we
  // render with `defaultOpen` and skip the animation on the first paint
  // to avoid a flash of open→closed when the saved state disagrees.
  const [hydrated, setHydrated] = useState(prefKey === undefined);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const fullKey = prefKey ? `${prefKey}.${id}` : null;

  useEffect(() => {
    if (!fullKey) return;
    let cancelled = false;
    invoke<string>('get_preference', {
      key: fullKey,
      defaultValue: defaultOpen ? 'True' : 'False',
    })
      .then((v) => {
        if (cancelled) return;
        setOpen(v !== 'False');
        setHydrated(true);
      })
      .catch(() => {
        if (cancelled) return;
        setHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, [fullKey, defaultOpen]);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (fullKey) {
        invoke('set_preference', {
          key: fullKey,
          value: next ? 'True' : 'False',
        }).catch(() => {});
      }
      return next;
    });
  }, [fullKey]);

  // Manage max-height for the animated reveal. We measure the body's
  // scrollHeight and animate between 0 and that value. Once the transition
  // ends on an "open" state we remove the cap so resizing content below
  // (lists, etc.) doesn't get clipped.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (!hydrated) {
      body.style.maxHeight = open ? 'none' : '0px';
      return;
    }
    if (open) {
      // If the body is already uncapped (`max-height: none`), don't
      // re-measure — the content can grow freely. Re-clamping to the
      // current scrollHeight here is what caused the "Animations
      // section is too short after collapse + reopen" symptom: a
      // measurement taken before async content (clip list, controls
      // row) lands sticks around, and CSS's transition from `none`
      // never fires `transitionend` to lift the cap again.
      if (body.style.maxHeight === 'none' || body.style.maxHeight === '') {
        return;
      }
      const target = body.scrollHeight;
      body.style.maxHeight = `${target}px`;
      const lift = () => {
        body.style.maxHeight = 'none';
      };
      const onEnd = (e: TransitionEvent) => {
        if (e.propertyName !== 'max-height') return;
        lift();
        body.removeEventListener('transitionend', onEnd);
      };
      body.addEventListener('transitionend', onEnd);
      // Hard fallback — some browsers / themes drop transitionend if
      // the duration ends up below the GC threshold, and a stuck
      // pixel cap would clip late-loading content. 350ms covers the
      // 220ms transition + a generous margin.
      const safety = window.setTimeout(lift, 350);
      return () => {
        body.removeEventListener('transitionend', onEnd);
        window.clearTimeout(safety);
      };
    } else {
      // From open → closed: set current height first so the transition
      // has somewhere to start, then collapse to 0.
      const cur = body.scrollHeight;
      body.style.maxHeight = `${cur}px`;
      // Force reflow so the browser registers the starting height.
      void body.offsetHeight;
      body.style.maxHeight = '0px';
    }
  }, [open, hydrated]);

  // ResizeObserver: when the inner content grows while the body is
  // open AND the cap hasn't been lifted yet (rare race during an
  // expand animation), bump max-height up to match so the new content
  // isn't clipped. No-op once max-height is `none`.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (typeof ResizeObserver === 'undefined') return;
    const inner = body.firstElementChild as HTMLElement | null;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (!open) return;
      const cap = body.style.maxHeight;
      if (!cap || cap === 'none' || cap === '0px') return;
      const target = inner.scrollHeight;
      // Always grow towards content; never shrink the cap below
      // current content height.
      if (target > parseFloat(cap)) {
        body.style.maxHeight = `${target}px`;
      }
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [open]);

  return (
    <section className={`jade-acc-section${open ? ' open' : ''}`}>
      <button
        type="button"
        className="jade-acc-header"
        aria-expanded={open}
        aria-controls={`jade-acc-body-${id}`}
        onClick={toggle}
      >
        {Icon ? <Icon size={14} className="jade-acc-icon" /> : null}
        <span className="jade-acc-title">{title}</span>
        {trailing ? <span className="jade-acc-trailing">{trailing}</span> : null}
        <ChevronDown size={14} className="jade-acc-chevron" />
      </button>
      <div
        id={`jade-acc-body-${id}`}
        ref={bodyRef}
        className="jade-acc-body"
        aria-hidden={!open}
      >
        <div className="jade-acc-body-inner">{children}</div>
      </div>
    </section>
  );
}
