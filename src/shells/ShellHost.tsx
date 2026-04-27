import VSCodeShell from './VSCodeShell';
import WordShell from './WordShell';
import VisualStudioShell from './VisualStudioShell';
import { useShell } from './ShellContext';

/**
 * Renders the matching shell based on `shellVariant` from context.
 * App.tsx is responsible for tracking the variant — it listens to the
 * `shell-changed` event and reads the `UiShell` preference on boot.
 */
export default function ShellHost() {
    const { shellVariant } = useShell();
    if (shellVariant === 'word') return <WordShell />;
    if (shellVariant === 'visualstudio') return <VisualStudioShell />;
    return <VSCodeShell />;
}
