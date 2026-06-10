import { useCallback, useRef, type ReactNode } from 'react';
import type { EditorGroup, EditorLayoutNode, EditorSplit } from './editorLayout';

/**
 * Recursive renderer for the editor-group tree.
 *
 * This component is layout-only: it arranges `split` nodes as flex
 * rows/columns with draggable resizers between siblings, and hands each
 * leaf `group` off to the `renderGroup` prop (App supplies the tab bar +
 * Monaco instance for a group). It owns NO tab/model state — that all
 * lives in App and flows in through `renderGroup`.
 *
 * Replaces the old hard-coded two-pane split in EditorPane +
 * SecondaryPaneView with something that handles any number of groups and
 * arbitrary nesting.
 */
export interface EditorGroupLayoutProps {
  node: EditorLayoutNode;
  /** Render a leaf group's content (tab strip + editor surface). */
  renderGroup: (group: EditorGroup) => ReactNode;
  /** Commit new fractional sizes for the split with `splitId`. */
  onResize: (splitId: string, sizes: number[]) => void;
  /** Minimum pixel size for any child during a resize drag. */
  minChildPx?: number;
}

const RESIZER_PX = 4;

export default function EditorGroupLayout({
  node,
  renderGroup,
  onResize,
  minChildPx = 120,
}: EditorGroupLayoutProps) {
  return (
    <LayoutNodeView
      node={node}
      renderGroup={renderGroup}
      onResize={onResize}
      minChildPx={minChildPx}
    />
  );
}

function LayoutNodeView({
  node,
  renderGroup,
  onResize,
  minChildPx,
}: {
  node: EditorLayoutNode;
  renderGroup: (group: EditorGroup) => ReactNode;
  onResize: (splitId: string, sizes: number[]) => void;
  minChildPx: number;
}) {
  if (node.kind === 'group') {
    return (
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, position: 'relative', display: 'flex' }}>
        {renderGroup(node)}
      </div>
    );
  }
  return (
    <SplitView
      split={node}
      renderGroup={renderGroup}
      onResize={onResize}
      minChildPx={minChildPx}
    />
  );
}

function SplitView({
  split,
  renderGroup,
  onResize,
  minChildPx,
}: {
  split: EditorSplit;
  renderGroup: (group: EditorGroup) => ReactNode;
  onResize: (splitId: string, sizes: number[]) => void;
  minChildPx: number;
}) {
  const isRow = split.orientation === 'row';
  const containerRef = useRef<HTMLDivElement>(null);

  // Drag the resizer between child `index` and `index + 1`.
  const startResize = useCallback(
    (index: number, e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const total = isRow ? rect.width : rect.height;
      if (total <= 0) return;
      const startPos = isRow ? e.clientX : e.clientY;
      const startSizes = [...split.sizes];
      const minFrac = minChildPx / total;

      const onMove = (ev: MouseEvent) => {
        const pos = isRow ? ev.clientX : ev.clientY;
        const deltaFrac = (pos - startPos) / total;
        // Move fraction between the two adjacent children only.
        let a = startSizes[index] + deltaFrac;
        let b = startSizes[index + 1] - deltaFrac;
        const pair = startSizes[index] + startSizes[index + 1];
        a = Math.max(minFrac, Math.min(pair - minFrac, a));
        b = pair - a;
        const next = [...startSizes];
        next[index] = a;
        next[index + 1] = b;
        onResize(split.id, next);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      document.body.style.cursor = isRow ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [isRow, split.id, split.sizes, onResize, minChildPx],
  );

  return (
    <div
      ref={containerRef}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: isRow ? 'row' : 'column',
        position: 'relative',
      }}
    >
      {split.children.map((child, i) => (
        <Fragmentish key={childKey(child)}>
          <div
            style={{
              flex: `${split.sizes[i] ?? 1 / split.children.length} 1 0`,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
            }}
          >
            <LayoutNodeView
              node={child}
              renderGroup={renderGroup}
              onResize={onResize}
              minChildPx={minChildPx}
            />
          </div>
          {i < split.children.length - 1 && (
            <div
              onMouseDown={(e) => startResize(i, e)}
              title="Drag to resize"
              style={{
                flex: `0 0 ${RESIZER_PX}px`,
                cursor: isRow ? 'col-resize' : 'row-resize',
                background: 'color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                position: 'relative',
                zIndex: 2,
              }}
            />
          )}
        </Fragmentish>
      ))}
    </div>
  );
}

/** A keyed fragment wrapper (React fragments can take a key but not in
 *  a map-with-extra-children pattern cleanly, so use a display:contents
 *  wrapper that doesn't affect flex layout). */
function Fragmentish({ children }: { children: ReactNode }) {
  return <div style={{ display: 'contents' }}>{children}</div>;
}

function childKey(node: EditorLayoutNode): string {
  return node.kind === 'group' ? `g:${node.id}` : `s:${node.id}`;
}
