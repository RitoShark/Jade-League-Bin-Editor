/**
 * Modal asking the user which champion + skin number to pull
 * animations from when the SKN's filename / folder didn't
 * conclusively identify them. Opens from the Pose panel's
 * "Fetch animations from game" button after the auto-detect
 * either returns nothing or returns a low-confidence guess.
 *
 * The champion list is just the canonical hardcoded set — Riot
 * doesn't ship a JSON manifest in the install that's easy to read
 * from Rust, and the list rarely changes. Mods almost never target
 * a champion we don't already list here.
 */

import { useEffect, useMemo, useState } from 'react';
import './FetchAnimationsDialog.css';

interface FetchAnimationsDialogProps {
    open: boolean;
    /** When the user has already pre-filled some / all of the
     *  fields (auto-detect succeeded partially), pass them here so
     *  the dialog opens with the inputs populated. */
    initialChampion?: string | null;
    initialSkinNum?: number | null;
    initialReason?: string;
    onCancel: () => void;
    onConfirm: (champion: string, skinNum: number, usePbe: boolean) => void;
}

/**
 * Canonical champion ids — lowercase, as they appear in WAD paths
 * and BIN string references. Keep alphabetical so the dropdown is
 * scannable. New champions land here when Riot ships them.
 */
const CHAMPIONS: string[] = [
    'aatrox', 'ahri', 'akali', 'akshan', 'alistar', 'ambessa', 'amumu', 'anivia', 'annie', 'aphelios',
    'ashe', 'aurelionsol', 'aurora', 'azir', 'bard', 'belveth', 'blitzcrank', 'brand', 'braum', 'briar',
    'caitlyn', 'camille', 'cassiopeia', 'chogath', 'corki', 'darius', 'diana', 'draven', 'drmundo',
    'ekko', 'elise', 'evelynn', 'ezreal', 'fiddlesticks', 'fiora', 'fizz', 'galio', 'gangplank',
    'garen', 'gnar', 'gragas', 'graves', 'gwen', 'hecarim', 'heimerdinger', 'hwei', 'illaoi', 'irelia',
    'ivern', 'janna', 'jarvaniv', 'jax', 'jayce', 'jhin', 'jinx', 'kaisa', 'kalista', 'karma',
    'karthus', 'kassadin', 'katarina', 'kayle', 'kayn', 'kennen', 'khazix', 'kindred', 'kled',
    'kogmaw', 'ksante', 'leblanc', 'leesin', 'leona', 'lillia', 'lissandra', 'lucian', 'lulu', 'lux',
    'malphite', 'malzahar', 'maokai', 'masteryi', 'mel', 'milio', 'missfortune', 'monkeyking', 'mordekaiser',
    'morgana', 'naafiri', 'nami', 'nasus', 'nautilus', 'neeko', 'nidalee', 'nilah', 'nocturne',
    'nunu', 'olaf', 'orianna', 'ornn', 'pantheon', 'poppy', 'pyke', 'qiyana', 'quinn', 'rakan',
    'rammus', 'reksai', 'rell', 'renata', 'renekton', 'rengar', 'riven', 'rumble', 'ryze', 'samira',
    'sejuani', 'senna', 'seraphine', 'sett', 'shaco', 'shen', 'shyvana', 'singed', 'sion', 'sivir',
    'skarner', 'smolder', 'sona', 'soraka', 'swain', 'sylas', 'syndra', 'tahmkench', 'taliyah',
    'talon', 'taric', 'teemo', 'thresh', 'tristana', 'trundle', 'tryndamere', 'twistedfate', 'twitch',
    'udyr', 'urgot', 'varus', 'vayne', 'veigar', 'velkoz', 'vex', 'vi', 'viego', 'viktor', 'vladimir',
    'volibear', 'warwick', 'xayah', 'xerath', 'xinzhao', 'yasuo', 'yone', 'yorick', 'yunara', 'yuumi',
    'zac', 'zed', 'zeri', 'ziggs', 'zilean', 'zoe', 'zyra',
];

export default function FetchAnimationsDialog({
    open,
    initialChampion,
    initialSkinNum,
    initialReason,
    onCancel,
    onConfirm,
}: FetchAnimationsDialogProps) {
    const [champion, setChampion] = useState<string>(initialChampion ?? '');
    const [skinNum, setSkinNum] = useState<number>(initialSkinNum ?? 0);
    const [query, setQuery] = useState('');
    const [usePbe, setUsePbe] = useState(false);

    // Re-seed inputs each time the dialog opens with new defaults —
    // staying open across multiple opens would leak previous values.
    useEffect(() => {
        if (open) {
            setChampion(initialChampion ?? '');
            setSkinNum(initialSkinNum ?? 0);
            setQuery('');
        }
    }, [open, initialChampion, initialSkinNum]);

    const filteredChampions = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return CHAMPIONS;
        return CHAMPIONS.filter(c => c.includes(q));
    }, [query]);

    if (!open) return null;

    const canConfirm = champion !== '' && skinNum >= 0;

    return (
        <div className="fa-modal-backdrop" onClick={onCancel}>
            <div className="fa-modal" onClick={e => e.stopPropagation()}>
                <div className="fa-modal-title">Fetch animations from game</div>
                {initialReason && (
                    <div className="fa-modal-hint">
                        Auto-detect: {initialReason}
                    </div>
                )}
                <div className="fa-modal-body">
                    <label className="fa-field">
                        <span className="fa-label">Champion</span>
                        <input
                            type="text"
                            className="fa-input"
                            placeholder="search…"
                            value={query}
                            onChange={e => setQuery(e.target.value)}
                        />
                    </label>
                    <div className="fa-champion-grid">
                        {filteredChampions.map(c => (
                            <button
                                key={c}
                                className={`fa-champion-pill${c === champion ? ' fa-champion-selected' : ''}`}
                                onClick={() => setChampion(c)}
                                type="button"
                            >
                                {c}
                            </button>
                        ))}
                        {filteredChampions.length === 0 && (
                            <div className="fa-empty">No matches.</div>
                        )}
                    </div>
                    <label className="fa-field fa-field-row">
                        <span className="fa-label">Skin number</span>
                        <input
                            type="number"
                            className="fa-input fa-input-num"
                            min={0}
                            max={99}
                            value={skinNum}
                            onChange={e => setSkinNum(Math.max(0, Math.min(99, parseInt(e.target.value || '0', 10) || 0)))}
                        />
                        <span className="fa-hint">0 = base skin</span>
                    </label>
                    <label className="fa-field fa-field-row">
                        <input
                            type="checkbox"
                            checked={usePbe}
                            onChange={e => setUsePbe(e.target.checked)}
                        />
                        <span className="fa-label">Use PBE install</span>
                    </label>
                </div>
                <div className="fa-modal-actions">
                    <button className="fa-btn" onClick={onCancel}>Cancel</button>
                    <button
                        className="fa-btn fa-btn-primary"
                        disabled={!canConfirm}
                        onClick={() => onConfirm(champion, skinNum, usePbe)}
                    >Fetch</button>
                </div>
            </div>
        </div>
    );
}
