import { useCallback, useRef, type ReactNode } from 'react';

interface FloatingToolWindowProps {
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
    onClose?: () => void;
    /** Pointerdown on the header — used by the parent shell to start a
     *  cross-window drag (the same gesture can move the float around or
     *  re-dock it onto a guide). */
    onHeaderPointerDown: (e: React.PointerEvent) => void;
    /** Pointerdown on the resize grip — parent handles the drag. */
    onResizePointerDown: (e: React.PointerEvent) => void;
    children: ReactNode;
}

/**
 * Free-floating overlay window for a tool that's been popped out of the
 * dock. The shell positions it absolutely, drives the move/resize via
 * global pointer listeners, and re-renders this with new x/y/w/h.
 */
export default function FloatingToolWindow({
    title,
    x, y, width, height,
    onClose,
    onHeaderPointerDown,
    onResizePointerDown,
    children,
}: FloatingToolWindowProps) {
    const wrapRef = useRef<HTMLDivElement | null>(null);

    const onResizeStart = useCallback((e: React.PointerEvent) => {
        e.stopPropagation();
        onResizePointerDown(e);
    }, [onResizePointerDown]);

    return (
        <div
            ref={wrapRef}
            className="vs-float-window"
            style={{ left: x, top: y, width, height }}
        >
            <div className="vs-float-header" onPointerDown={onHeaderPointerDown}>
                <span className="vs-float-title">{title}</span>
                {onClose && (
                    <button
                        type="button"
                        className="vs-dock-close"
                        onClick={onClose}
                        onPointerDown={e => e.stopPropagation()}
                        aria-label="Close tool window"
                    >
                        &times;
                    </button>
                )}
            </div>
            <div className="vs-float-body">{children}</div>
            <div className="vs-float-resize" onPointerDown={onResizeStart} />
        </div>
    );
}
