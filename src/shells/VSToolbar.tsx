import {
    SearchIcon, ReplaceIcon, EditIcon, SparklesIcon, LibraryIcon,
    PaletteIcon, SettingsIcon, HelpIcon,
} from '../components/Icons';
import { useShell } from './ShellContext';

interface ToolbarBtnProps {
    title: string;
    onClick: () => void;
    icon: React.ReactNode;
    active?: boolean;
    disabled?: boolean;
}

function ToolbarBtn({ title, onClick, icon, active, disabled }: ToolbarBtnProps) {
    return (
        <button
            type="button"
            className={`vs-toolbar-btn${active ? ' active' : ''}`}
            onClick={onClick}
            disabled={disabled}
            title={title}
            aria-label={title}
        >
            {icon}
        </button>
    );
}

/**
 * Visual Studio quick-action toolbar — sits between MenuBar and the
 * editor body. Mirrors VS's small-icon toolbar with grouped actions
 * separated by vertical dividers. Hover for full label.
 */
export default function VSToolbar() {
    const s = useShell();
    const binDisabled = !s.isBinFileOpen();

    return (
        <div className="vs-toolbar">
            <ToolbarBtn title="Find (Ctrl+F)" onClick={s.onFind} icon={<SearchIcon size={15} />} active={s.findWidgetOpen} />
            <ToolbarBtn title="Replace (Ctrl+H)" onClick={s.onReplace} icon={<ReplaceIcon size={15} />} active={s.replaceWidgetOpen} />

            <div className="vs-toolbar-sep" />

            <ToolbarBtn
                title="General Editing (Ctrl+O)"
                onClick={s.onGeneralEdit}
                icon={<EditIcon size={15} />}
                active={s.generalEditPanelOpen}
            />
            <ToolbarBtn
                title={binDisabled ? 'Particle Editing (bin/py only)' : 'Particle Editing (Ctrl+P)'}
                onClick={s.onParticlePanel}
                icon={<SparklesIcon size={15} />}
                active={s.particlePanelOpen}
                disabled={binDisabled}
            />
            <ToolbarBtn title="Material Library" onClick={s.onMaterialLibrary} icon={<LibraryIcon size={15} />} />

            <div className="vs-toolbar-sep" />

            <ToolbarBtn title="Themes" onClick={s.onThemes} icon={<PaletteIcon size={15} />} />
            <ToolbarBtn title="Settings" onClick={s.onSettings} icon={<SettingsIcon size={15} />} />

            <div className="vs-toolbar-spacer" />

            <ToolbarBtn title="About" onClick={s.onAbout} icon={<HelpIcon size={15} />} />
        </div>
    );
}
