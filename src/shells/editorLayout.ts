/**
 * Editor layout tree — the model behind VSCode-style editor groups.
 *
 * Replaces the old binary `tab.pane: 'left' | 'right'` split. The editor
 * area is a recursive tree of:
 *   - `group`: a leaf holding an ordered list of tab ids + its active tab.
 *     Each group renders its own tab bar and Monaco instance.
 *   - `split`: an internal node arranging 2+ children in a `row`
 *     (side by side) or `column` (stacked), with fractional `sizes`.
 *
 * A plain unsplit editor is a tree of one `group`. Splitting a group
 * wraps it in a `split` with a new sibling group. This supports an
 * arbitrary number of groups and arbitrary nesting.
 *
 * Every operation here is PURE and returns a new tree (or the same
 * reference when nothing changed). Tab *content* lives in App's `tabs`
 * array + the Monaco model registry; the tree only stores tab *ids*.
 */

export interface EditorGroup {
  kind: 'group';
  id: string;
  /** Ordered tab ids shown in this group's tab bar. */
  tabIds: string[];
  /** The tab currently displayed in this group, or null if empty. */
  activeTabId: string | null;
}

export interface EditorSplit {
  kind: 'split';
  id: string;
  /** `row` = children laid out left→right; `column` = top→bottom. */
  orientation: 'row' | 'column';
  children: EditorLayoutNode[];
  /** Fractional sizes, one per child, summing to ~1. */
  sizes: number[];
}

export type EditorLayoutNode = EditorGroup | EditorSplit;

export type SplitEdge = 'left' | 'right' | 'top' | 'bottom';

// ── id generation ───────────────────────────────────────────────────
let groupSeq = 0;
let splitSeq = 0;
export function newGroupId(): string {
  groupSeq += 1;
  return `grp-${groupSeq}`;
}
export function newSplitId(): string {
  splitSeq += 1;
  return `spl-${splitSeq}`;
}

// ── constructors ────────────────────────────────────────────────────
export function makeGroup(tabIds: string[] = [], activeTabId: string | null = null): EditorGroup {
  return {
    kind: 'group',
    id: newGroupId(),
    tabIds,
    activeTabId: activeTabId ?? tabIds[0] ?? null,
  };
}

/** A fresh single-group layout (the unsplit default). */
export function singleGroupLayout(tabIds: string[] = [], activeTabId: string | null = null): EditorLayoutNode {
  return makeGroup(tabIds, activeTabId);
}

// ── traversal ───────────────────────────────────────────────────────

/** All groups in left-to-right / top-to-bottom render order. */
export function allGroups(node: EditorLayoutNode): EditorGroup[] {
  if (node.kind === 'group') return [node];
  return node.children.flatMap(allGroups);
}

/** The first (leftmost/topmost) group — the default focus target. */
export function firstGroup(node: EditorLayoutNode): EditorGroup {
  return allGroups(node)[0];
}

export function findGroup(node: EditorLayoutNode, groupId: string): EditorGroup | null {
  return allGroups(node).find(g => g.id === groupId) ?? null;
}

/** The group currently containing `tabId`, or null. */
export function groupOfTab(node: EditorLayoutNode, tabId: string): EditorGroup | null {
  return allGroups(node).find(g => g.tabIds.includes(tabId)) ?? null;
}

export function groupCount(node: EditorLayoutNode): number {
  return allGroups(node).length;
}

/** Every tab id referenced anywhere in the tree. */
export function allTabIds(node: EditorLayoutNode): string[] {
  return allGroups(node).flatMap(g => g.tabIds);
}

// ── immutable group update ──────────────────────────────────────────

/** Return a new tree with `fn` applied to the group matching `groupId`. */
export function updateGroup(
  node: EditorLayoutNode,
  groupId: string,
  fn: (g: EditorGroup) => EditorGroup,
): EditorLayoutNode {
  if (node.kind === 'group') {
    return node.id === groupId ? fn(node) : node;
  }
  let changed = false;
  const children = node.children.map(c => {
    const next = updateGroup(c, groupId, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/** Apply `fn` to every group in the tree. */
export function mapGroups(
  node: EditorLayoutNode,
  fn: (g: EditorGroup) => EditorGroup,
): EditorLayoutNode {
  if (node.kind === 'group') return fn(node);
  let changed = false;
  const children = node.children.map(c => {
    const next = mapGroups(c, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

// ── normalization ───────────────────────────────────────────────────

function normalizeSizes(sizes: number[], n: number): number[] {
  if (sizes.length !== n || sizes.some(s => !Number.isFinite(s) || s <= 0)) {
    return Array(n).fill(1 / n);
  }
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum <= 0) return Array(n).fill(1 / n);
  return sizes.map(s => s / sum);
}

/**
 * Collapse degeneracies after a mutation:
 *   - empty groups are removed (unless it's the only group left),
 *   - a split with one child is replaced by that child,
 *   - a split whose child has the same orientation is flattened in,
 *   - sizes are renormalized to match child count.
 * Always returns a valid tree with at least one group.
 */
export function simplify(node: EditorLayoutNode): EditorLayoutNode {
  if (node.kind === 'group') return node;

  // Simplify children first.
  let children = node.children.map(simplify);

  // Drop empty groups.
  children = children.filter(c => !(c.kind === 'group' && c.tabIds.length === 0));

  // Flatten same-orientation nested splits.
  const flattened: EditorLayoutNode[] = [];
  for (const c of children) {
    if (c.kind === 'split' && c.orientation === node.orientation) {
      flattened.push(...c.children);
    } else {
      flattened.push(c);
    }
  }
  children = flattened;

  if (children.length === 0) {
    // Everything collapsed away — yield an empty group so the tree
    // always has a render target. Callers that removed the last tab
    // handle the "no tabs at all" case above this layer.
    return makeGroup();
  }
  if (children.length === 1) return children[0];

  return {
    ...node,
    children,
    sizes: normalizeSizes(node.sizes, children.length),
  };
}

// ── tab lifecycle ───────────────────────────────────────────────────

/** Add `tabId` to a group (default: focused/first), making it active. */
export function addTabToGroup(
  node: EditorLayoutNode,
  groupId: string,
  tabId: string,
  makeActive = true,
): EditorLayoutNode {
  return updateGroup(node, groupId, g => {
    if (g.tabIds.includes(tabId)) {
      return makeActive ? { ...g, activeTabId: tabId } : g;
    }
    return {
      ...g,
      tabIds: [...g.tabIds, tabId],
      activeTabId: makeActive ? tabId : g.activeTabId,
    };
  });
}

/**
 * Remove `tabId` from whatever group holds it. If that empties a
 * non-root group, the tree is simplified (group collapses). Picks a
 * sensible new active tab for the group the tab left.
 */
export function removeTab(node: EditorLayoutNode, tabId: string): EditorLayoutNode {
  const owner = groupOfTab(node, tabId);
  if (!owner) return node;
  const next = updateGroup(node, owner.id, g => {
    const idx = g.tabIds.indexOf(tabId);
    if (idx < 0) return g;
    const tabIds = g.tabIds.filter(id => id !== tabId);
    let activeTabId = g.activeTabId;
    if (activeTabId === tabId) {
      // Prefer the neighbour to the right, else the new last tab.
      activeTabId = tabIds[idx] ?? tabIds[idx - 1] ?? tabIds[tabIds.length - 1] ?? null;
    }
    return { ...g, tabIds, activeTabId };
  });
  return simplify(next);
}

/** Set a group's active tab (no-op if the tab isn't in the group). */
export function setGroupActiveTab(
  node: EditorLayoutNode,
  groupId: string,
  tabId: string,
): EditorLayoutNode {
  return updateGroup(node, groupId, g =>
    g.tabIds.includes(tabId) && g.activeTabId !== tabId ? { ...g, activeTabId: tabId } : g,
  );
}

/** Move an existing tab into `targetGroupId`, removing it from its old group. */
export function moveTabToGroup(
  node: EditorLayoutNode,
  tabId: string,
  targetGroupId: string,
  makeActive = true,
): EditorLayoutNode {
  const owner = groupOfTab(node, tabId);
  if (owner && owner.id === targetGroupId) {
    return makeActive ? setGroupActiveTab(node, targetGroupId, tabId) : node;
  }
  const without = removeTab(node, tabId);
  // `removeTab` may have collapsed/simplified — the target group still
  // exists by id as long as it wasn't the emptied one.
  if (!findGroup(without, targetGroupId)) return without;
  return addTabToGroup(without, targetGroupId, tabId, makeActive);
}

// ── splitting ───────────────────────────────────────────────────────

/**
 * Split `targetGroupId` along `edge`, creating a new sibling group that
 * receives `tabId` (moved out of its current group). The new group ends
 * up on the side indicated by `edge`. Returns the new tree (simplified).
 */
export function splitGroupWithTab(
  node: EditorLayoutNode,
  targetGroupId: string,
  edge: SplitEdge,
  tabId: string,
): { layout: EditorLayoutNode; newGroupId: string } {
  const orientation: 'row' | 'column' = edge === 'left' || edge === 'right' ? 'row' : 'column';
  const newGroup = makeGroup([], null);
  const newGroupId = newGroup.id;

  // First pull the tab out of its current group (so it doesn't appear twice).
  const pulled = removeTab(node, tabId);

  // The target group may have been the one emptied+collapsed. If it's
  // gone, just drop the tab into the first remaining group.
  if (!findGroup(pulled, targetGroupId)) {
    const fallback = firstGroup(pulled);
    const withTab = addTabToGroup(pulled, fallback.id, tabId, true);
    return { layout: simplify(withTab), newGroupId: fallback.id };
  }

  const filledNew: EditorGroup = { ...newGroup, tabIds: [tabId], activeTabId: tabId };

  // Replace the target group with a split of [target, new] (order by edge).
  const replaceTarget = (n: EditorLayoutNode): EditorLayoutNode => {
    if (n.kind === 'group') {
      if (n.id !== targetGroupId) return n;
      const before = edge === 'left' || edge === 'top';
      const children = before ? [filledNew, n] : [n, filledNew];
      const split: EditorSplit = {
        kind: 'split',
        id: newSplitId(),
        orientation,
        children,
        sizes: [0.5, 0.5],
      };
      return split;
    }
    let changed = false;
    const children = n.children.map(c => {
      const next = replaceTarget(c);
      if (next !== c) changed = true;
      return next;
    });
    return changed ? { ...n, children } : n;
  };

  return { layout: simplify(replaceTarget(pulled)), newGroupId };
}

// ── sizing ──────────────────────────────────────────────────────────

/** Set the `sizes` of the split node identified by `splitId`. */
export function setSplitSizes(
  node: EditorLayoutNode,
  splitId: string,
  sizes: number[],
): EditorLayoutNode {
  if (node.kind === 'group') return node;
  if (node.id === splitId) {
    return { ...node, sizes: normalizeSizes(sizes, node.children.length) };
  }
  let changed = false;
  const children = node.children.map(c => {
    const next = setSplitSizes(c, splitId, sizes);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

/**
 * Collapse the whole tree into a single group holding every tab (in
 * render order). Used by "unsplit". `keepActive` becomes the group's
 * active tab when it's present.
 */
export function mergeAllGroups(node: EditorLayoutNode, keepActive: string | null): EditorLayoutNode {
  const ids = allTabIds(node);
  const active = keepActive && ids.includes(keepActive) ? keepActive : (ids[0] ?? null);
  return makeGroup(ids, active);
}

// ── reconciliation with the canonical tab list ──────────────────────

/**
 * Ensure the tree references exactly the tabs in `tabIds`:
 *   - tabs no longer present are removed,
 *   - tabs present but absent from the tree are appended to the first
 *     group (e.g. restored sessions, programmatically-opened tabs).
 * Keeps the tree valid + simplified. Returns the same reference when
 * already consistent.
 */
export function reconcile(node: EditorLayoutNode, tabIds: string[]): EditorLayoutNode {
  const valid = new Set(tabIds);
  const present = new Set(allTabIds(node));

  let next = node;

  // Remove stale ids.
  for (const id of present) {
    if (!valid.has(id)) next = removeTab(next, id);
  }
  // Append missing ids to the first group.
  const have = new Set(allTabIds(next));
  const missing = tabIds.filter(id => !have.has(id));
  if (missing.length > 0) {
    const target = firstGroup(next).id;
    for (const id of missing) {
      next = addTabToGroup(next, target, id, false);
    }
  }
  return next === node ? node : simplify(next);
}

/**
 * Like `reconcile`, but appends newly-present tabs (and makes them
 * active) in `targetGroupId` when it still exists — so freshly-opened
 * tabs land in the focused group, matching VSCode. Falls back to the
 * first group if the target is gone.
 */
export function reconcileInto(
  node: EditorLayoutNode,
  tabIds: string[],
  targetGroupId: string,
): EditorLayoutNode {
  const valid = new Set(tabIds);
  let next = node;

  for (const id of allTabIds(node)) {
    if (!valid.has(id)) next = removeTab(next, id);
  }
  const have = new Set(allTabIds(next));
  const missing = tabIds.filter(id => !have.has(id));
  if (missing.length > 0) {
    const target = findGroup(next, targetGroupId) ? targetGroupId : firstGroup(next).id;
    for (const id of missing) {
      next = addTabToGroup(next, target, id, true);
    }
  }
  return next === node ? node : simplify(next);
}
