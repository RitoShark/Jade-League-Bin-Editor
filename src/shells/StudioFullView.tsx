import StudioTab from '../components/StudioTab';
import AnimStudioTab from '../components/AnimStudioTab';
import TabBar from '../components/TabBar';
import { useShell } from './ShellContext';

/**
 * Full-area takeover for Studio / Anim Studio tabs.
 *
 * Studios are full-app views (their own toolbars/panels up top) and
 * don't share the bin editor's chrome, so they can't live inside a split
 * group. Whenever the active tab is a studio, the VS shell hides the
 * split layout (kept mounted) and shows this instead — the editor reads
 * as UNSPLIT for the duration. Switching back to any other tab restores
 * the previous split exactly, because the layout state is never touched.
 *
 * This component is mounted unconditionally by the shell, so the studio
 * scenes inside it stay alive across every tab switch (a Babylon scene is
 * never disposed). The tab strip up top lists EVERY tab — clicking a bin
 * runs the normal tab-select, which drops us back into the split view
 * with that bin active.
 */
export default function StudioFullView() {
  const s = useShell();
  const activeTab = s.activeTabId ? s.tabs.find(t => t.id === s.activeTabId) ?? null : null;
  const visible = activeTab?.tabType === 'studio' || activeTab?.tabType === 'animstudio';

  const studios = s.tabs.filter(t => t.tabType === 'studio' || t.tabType === 'animstudio');
  if (studios.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        background: 'var(--editor-bg, #1e1e1e)',
      }}
    >
      {/* Full tab strip — every open tab, so you can jump straight to any
          bin (which exits the studio and restores the split). No split
          controls: a studio is always one unsplit view. */}
      <TabBar
        tabs={s.tabs}
        activeTabId={s.activeTabId}
        onTabSelect={s.onTabSelect}
        onTabClose={s.onTabClose}
        onTabCloseAll={s.onTabCloseAll}
        onTabPin={s.onTabPin}
        onRevealInExplorer={s.revealInExplorer}
        onOpenNodeGraph={s.openNodeGraph}
      />
      <div style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
        {studios.map(t => (
          <div
            key={t.id}
            style={{ position: 'absolute', inset: 0, display: s.activeTabId === t.id ? 'block' : 'none' }}
          >
            {t.tabType === 'animstudio'
              ? <AnimStudioTab tabId={t.id} />
              : <StudioTab tabId={t.id} />}
          </div>
        ))}
      </div>
    </div>
  );
}
