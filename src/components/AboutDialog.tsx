import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
    X, BookOpen, RotateCcw, Heart, Pencil, Trash2,
    Coffee, Code2,
} from 'lucide-react';

/** Brand glyphs (Discord / GitHub / PayPal). Inline so we don't pull
 *  another icon library; `currentColor` makes them inherit the button's
 *  text color so the variant-hover tints just work. */
const ICON_PROPS = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', 'aria-hidden': true } as const;
const DiscordIcon = () => (
    <svg {...ICON_PROPS}>
        <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/>
    </svg>
);
const GithubIcon = () => (
    <svg {...ICON_PROPS}>
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>
    </svg>
);
const PaypalIcon = () => (
    <svg {...ICON_PROPS}>
        <path d="M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z"/>
    </svg>
);
import type { ReactNode } from 'react';
import './AboutDialog.css';

const BUILTIN_ICONS = [
    { name: 'jade', path: '/media/jade.ico', label: 'Jade' },
    { name: 'jadejade', path: '/media/jadejade.ico', label: 'JadeJade' },
    { name: 'noBrain', path: '/media/noBrain.ico', label: 'No Brain' },
];

/** Credits — edit the entries below to update the About dialog.
 *  Each name can be a plain string (just the name) or `{ name, note }`
 *  for the longer form "Name — note". Variant controls pill color
 *  (see AboutDialog.css). Order matters: groups render top-to-bottom
 *  in this order. */
type CreditEntry = string | { name: string; note?: string };

interface CreditGroup {
    label: string;
    icon: ReactNode;
    variant: 'donor' | 'contributor';
    names: CreditEntry[];
}

const CREDIT_GROUPS: CreditGroup[] = [
    {
        label: 'Donors',
        icon: <Coffee size={11} />,
        variant: 'donor',
        names: ['konradosj', 'hellgoat2'],
    },
    {
        label: 'Code contributors',
        icon: <Code2 size={11} />,
        variant: 'contributor',
        names: [
            { name: 'SirDexal', note: 'set the foundation up' },
            { name: 'Frog', note: 'improved Quartz bin sending and ux' },
            { name: '700', note: 'added 4 themes and font changing'},
        ],
    },
];

interface AboutDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onRestartGuide?: () => void;
}

export default function AboutDialog({ isOpen, onClose, onRestartGuide }: AboutDialogProps) {
    const [appIcon, setAppIcon] = useState<string>('/media/jade.ico');
    const [selectedBuiltin, setSelectedBuiltin] = useState<string | null>('jade');
    const [version, setVersion] = useState<string>('1.0.0');

    useEffect(() => {
        if (isOpen) {
            loadAppIcon();
            loadVersion();
        }
    }, [isOpen]);

    const loadAppIcon = async () => {
        try {
            const builtinName = await invoke<string | null>('get_builtin_icon_name');
            setSelectedBuiltin(builtinName);

            if (builtinName) {
                const icon = BUILTIN_ICONS.find(i => i.name === builtinName);
                if (icon) {
                    setAppIcon(icon.path);
                    return;
                }
            }

            const iconData = await invoke<string | null>('get_custom_icon_data');
            if (iconData) {
                setAppIcon(iconData);
            } else {
                setAppIcon('/media/jade.ico');
                setSelectedBuiltin('jade');
            }
        } catch (error) {
            console.error('Failed to load icon:', error);
        }
    };

    const loadVersion = async () => {
        try {
            const ver = await invoke<string>('get_app_version');
            setVersion(ver);
        } catch (error) {
            console.error('Failed to load version:', error);
        }
    };

    const handleBuiltinIconSelect = async (iconName: string) => {
        try {
            if (iconName === 'jade') {
                await invoke('clear_custom_icon');
                setAppIcon('/media/jade.ico');
                setSelectedBuiltin('jade');
                window.dispatchEvent(new CustomEvent('icon-changed', { detail: null }));
            } else {
                await invoke('set_builtin_icon', { name: iconName });
                const icon = BUILTIN_ICONS.find(i => i.name === iconName);
                if (icon) setAppIcon(icon.path);
                setSelectedBuiltin(iconName);
                const iconData = await invoke<string | null>('get_custom_icon_data');
                window.dispatchEvent(new CustomEvent('icon-changed', { detail: iconData }));
            }
        } catch (error) {
            console.error('Failed to set builtin icon:', error);
        }
    };

    const handleCustomIconClick = async () => {
        try {
            const filePath = await open({
                filters: [{ name: 'Icon Files', extensions: ['ico', 'png'] }],
                multiple: false,
            });

            if (filePath) {
                await invoke('set_custom_icon', { iconPath: filePath });
                const iconData = await invoke<string | null>('get_custom_icon_data');
                if (iconData) {
                    setAppIcon(iconData);
                    setSelectedBuiltin(null);
                    window.dispatchEvent(new CustomEvent('icon-changed', { detail: iconData }));
                }
            }
        } catch (error) {
            console.error('Failed to change icon:', error);
        }
    };

    const handleClearIcon = async () => {
        try {
            await invoke('clear_custom_icon');
            setAppIcon('/media/jade.ico');
            setSelectedBuiltin('jade');
            window.dispatchEvent(new CustomEvent('icon-changed', { detail: null }));
        } catch (error) {
            console.error('Failed to clear icon:', error);
        }
    };

    const handleDocumentationClick = () => {
        invoke('open_url', { url: 'https://github.com/LeagueToolkit/Jade-League-Bin-Editor' });
    };

    const handleReportIssueClick = () => {
        invoke('open_url', { url: 'https://github.com/LeagueToolkit/Jade-League-Bin-Editor/issues/new' });
    };

    const handleDiscordClick = () => {
        invoke('open_url', { url: 'http://discordapp.com/users/464506365402939402' });
    };

    const handleDonateClick = () => {
        invoke('open_url', { url: 'https://www.paypal.com/paypalme/budlibu500' });
    };

    if (!isOpen) return null;

    // Order icons: active centered, others on the sides — same logic as before.
    const activeBuiltin = selectedBuiltin ?? 'jade';
    const activeIdx = BUILTIN_ICONS.findIndex(i => i.name === activeBuiltin);
    const sideIcons = BUILTIN_ICONS.filter((_, i) => i !== activeIdx);

    return (
        <div className="about-overlay" onClick={onClose}>
            <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
                <div className="about-title-bar" data-tauri-drag-region>
                    <span className="about-title-text">About Jade</span>
                    <button className="about-close-btn" onClick={onClose} aria-label="Close">
                        <X size={16} />
                    </button>
                </div>

                <div className="about-body">
                    {/* Hero column — icon trio, name, subtitle, version + author lines */}
                    <section className="about-hero">
                        <div className="about-icon-row">
                            {sideIcons[0] && (
                                <button
                                    className="about-icon-btn side"
                                    onClick={() => handleBuiltinIconSelect(sideIcons[0].name)}
                                    title={sideIcons[0].label}
                                >
                                    <img src={sideIcons[0].path} alt={sideIcons[0].label} />
                                </button>
                            )}
                            <div className="about-icon-wrapper">
                                <button
                                    className="about-icon-btn active"
                                    onClick={handleCustomIconClick}
                                    title="Click to choose a custom icon"
                                >
                                    <img src={appIcon} alt="Jade" />
                                    <span className="about-icon-edit" aria-hidden="true">
                                        <Pencil size={11} />
                                    </span>
                                </button>
                                {selectedBuiltin === null && (
                                    <button
                                        className="about-icon-clear"
                                        onClick={handleClearIcon}
                                        title="Reset to default icon"
                                        aria-label="Reset icon"
                                    >
                                        <Trash2 size={11} />
                                    </button>
                                )}
                            </div>
                            {sideIcons[1] && (
                                <button
                                    className="about-icon-btn side"
                                    onClick={() => handleBuiltinIconSelect(sideIcons[1].name)}
                                    title={sideIcons[1].label}
                                >
                                    <img src={sideIcons[1].path} alt={sideIcons[1].label} />
                                </button>
                            )}
                        </div>

                        <h1 className="about-app-name">Jade</h1>
                        <p className="about-app-subtitle">BIN editor for League of Legends</p>

                        <div className="about-meta">
                            <div className="about-meta-row">
                                <span className="about-meta-key">Version</span>
                                <span className="about-meta-val">{version}</span>
                            </div>
                            <div className="about-meta-row">
                                <span className="about-meta-key">Author</span>
                                <span className="about-meta-val">budlibu500</span>
                            </div>
                        </div>

                        <div className="about-section-label about-section-label-mt">Project</div>
                        <div className="about-btn-stack">
                            {onRestartGuide && (
                                <button
                                    className="about-btn variant-restart-guide"
                                    onClick={() => { onRestartGuide(); onClose(); }}
                                >
                                    <RotateCcw size={14} />
                                    <span>Restart guide</span>
                                    <img
                                        src="/media/Rare_Creation_Wisteria_Cake.webp"
                                        alt=""
                                        className="about-btn-mascot"
                                        draggable={false}
                                    />
                                </button>
                            )}
                            <button className="about-btn" onClick={handleDocumentationClick}>
                                <BookOpen size={14} />
                                <span>Documentation</span>
                            </button>
                        </div>
                    </section>

                    {/* Social + credits */}
                    <section className="about-actions">
                        <div className="about-section-label">Social</div>
                        <div className="about-btn-stack">
                            <button className="about-btn variant-issue" onClick={handleReportIssueClick}>
                                <GithubIcon />
                                <span>Open GitHub issue <span className="about-btn-sub">- report issues</span></span>
                            </button>
                            <button className="about-btn variant-discord" onClick={handleDiscordClick}>
                                <DiscordIcon />
                                <span>DM me on Discord <span className="about-btn-sub">- provide feedback</span></span>
                            </button>
                            <button
                                className="about-btn variant-donate"
                                onClick={handleDonateClick}
                                title="Donors get featured in the special thanks list"
                            >
                                <PaypalIcon />
                                <span>Donate on PayPal <span className="about-btn-sub">- help the project</span></span>
                            </button>
                        </div>

                        <div className="about-thanks">
                            <div className="about-section-label about-section-label-mt">
                                <Heart size={11} />
                                <span>Special thanks</span>
                            </div>
                            {CREDIT_GROUPS.map(group => (
                                <div className="about-credits-group" key={group.label}>
                                    <div className="about-credits-group-label">
                                        {group.icon}
                                        <span>{group.label}</span>
                                    </div>
                                    <div className="about-credits-rows">
                                        {group.names.map((entry, idx) => {
                                            const name = typeof entry === 'string' ? entry : entry.name;
                                            const note = typeof entry === 'string' ? undefined : entry.note;
                                            return (
                                                <div
                                                    key={`${name}-${idx}`}
                                                    className={`about-credits-row variant-${group.variant}`}
                                                >
                                                    <span className="about-credits-name">{name}</span>
                                                    {note && (
                                                        <span className="about-credits-note">- {note}</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}
