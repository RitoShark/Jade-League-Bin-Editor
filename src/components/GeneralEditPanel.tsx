import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './GeneralEditPanel.css';
import MaterialOverrideDialog from './MaterialOverrideDialog';

interface MaterialMatch {
  material: string;
  texture: string;
}

interface AutoMaterialResult {
  matches: MaterialMatch[];
  skn_path: string;
  unmatched: string[];
  textures: string[];
}

interface GeneralEditPanelProps {
  isOpen: boolean;
  onClose: () => void;
  editorContent: string;
  onContentChange: (newContent: string) => void;
  filePath?: string;
  /** Called after a library material's textures are successfully copied
   *  into the user's mod. The parent uses this to track per-session
   *  inserts so it can offer cleanup when the user closes without saving. */
  onLibraryInsert?: (filePath: string, modRoot: string, id: string) => void;
}

export default function GeneralEditPanel({
  isOpen,
  onClose,
  editorContent,
  onContentChange,
  filePath,
  onLibraryInsert
}: GeneralEditPanelProps) {
  // Animation state - for slide down animation like Monaco
  const [isVisible, setIsVisible] = useState(false);
  const [isRendered, setIsRendered] = useState(false);
  const [panelRight, setPanelRight] = useState('28px');
  
  // SkinScale state
  const [skinScaleValue, setSkinScaleValue] = useState('1.0');
  const [percentageValue, setPercentageValue] = useState('100');
  const [originalSkinScale, setOriginalSkinScale] = useState(1.0);
  const [skinScaleExists, setSkinScaleExists] = useState(false);
  const [skinScaleStatus, setSkinScaleStatus] = useState('');
  
  // MaterialOverride state
  const [materialOverrideExists, setMaterialOverrideExists] = useState(false);
  const [materialOverrideStatus, setMaterialOverrideStatus] = useState('');
  const [showMaterialDialog, setShowMaterialDialog] = useState(false);
  const [materialDialogType, setMaterialDialogType] = useState<'texture' | 'material'>('texture');
  const [defaultTexturePath, setDefaultTexturePath] = useState('');
  
  // Auto-material state
  const [autoMaterialLoading, setAutoMaterialLoading] = useState(false);
  const [dialogSuggestions, setDialogSuggestions] = useState<{ material: string; texture: string }[]>([]);
  const [dialogTextures, setDialogTextures] = useState<string[]>([]);

  // Section collapse state
  const [skinScaleCollapsed, setSkinScaleCollapsed] = useState(false);
  const [materialOverrideCollapsed, setMaterialOverrideCollapsed] = useState(false);
  
  const isUpdatingFromPercentage = useRef(false);

  const updatePanelPosition = useCallback(() => {
    const editorContainer = document.querySelector('.editor-container') as HTMLElement | null;
    if (!editorContainer) return;

    const containerRect = editorContainer.getBoundingClientRect();
    const findWidget = editorContainer.querySelector('.monaco-editor .find-widget') as HTMLElement | null;
    if (findWidget) {
      const widgetRect = findWidget.getBoundingClientRect();
      const rightOffset = Math.max(0, containerRect.right - widgetRect.right);
      setPanelRight(`${Math.round(rightOffset)}px`);
      return;
    }

    const minimap = editorContainer.querySelector('.monaco-editor .minimap') as HTMLElement | null;
    if (minimap) {
      const minimapRect = minimap.getBoundingClientRect();
      const minimapWidth = Math.max(0, containerRect.right - minimapRect.left);
      setPanelRight(`${Math.round(minimapWidth + 14)}px`);
      return;
    }

    setPanelRight('28px');
  }, []);

  // Handle open/close animation
  useEffect(() => {
    if (isOpen) {
      // First render the element
      setIsRendered(true);
      // Then trigger animation on next frame
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setIsVisible(true);
        });
      });
      updatePanelPosition();
    } else {
      // First hide with animation
      setIsVisible(false);
      // Then unmount after animation completes
      const timer = setTimeout(() => {
        setIsRendered(false);
      }, 200); // Match CSS transition duration
      return () => clearTimeout(timer);
    }
  }, [isOpen, updatePanelPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handleResize = () => updatePanelPosition();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isOpen, updatePanelPosition]);

  // Load skinScale value from content
  const loadSkinScaleValue = useCallback(() => {
    if (!editorContent) {
      setSkinScaleStatus('No file loaded');
      setSkinScaleExists(false);
      return;
    }

    const lines = editorContent.split('\n');
    
    for (const line of lines) {
      const trimmedLine = line.trim().toLowerCase();
      if (trimmedLine.startsWith('skinscale:')) {
        // Extract the value after the colon
        const colonIndex = line.indexOf(':');
        let valuePart = line.substring(colonIndex + 1).trim();
        
        // Extract just the number, removing "f32 = " or similar prefixes
        if (valuePart.includes('=')) {
          const equalsIndex = valuePart.indexOf('=');
          valuePart = valuePart.substring(equalsIndex + 1).trim();
        }
        
        setSkinScaleValue(valuePart);
        setSkinScaleExists(true);
        
        const parsedValue = parseFloat(valuePart);
        if (!isNaN(parsedValue)) {
          setOriginalSkinScale(parsedValue);
        }
        
        setSkinScaleStatus('Value loaded');
        return;
      }
    }
    
    setSkinScaleStatus('skinScale not found');
    setSkinScaleExists(false);
  }, [editorContent]);

  // Check if materialOverride exists
  const checkMaterialOverride = useCallback(() => {
    if (!editorContent) {
      setMaterialOverrideStatus('No file loaded');
      setMaterialOverrideExists(false);
      return;
    }

    const hasMaterialOverride = editorContent.includes('materialOverride:');
    setMaterialOverrideExists(hasMaterialOverride);
    setMaterialOverrideStatus(hasMaterialOverride ? 'materialOverride detected' : 'materialOverride not found');
  }, [editorContent]);

  // Extract texture path for default value
  const extractTexturePath = useCallback(() => {
    if (!editorContent) return '';
    
    const lines = editorContent.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.toLowerCase().startsWith('texture:')) {
        const parts = trimmedLine.split('=');
        if (parts.length >= 2) {
          let pathPart = parts[1].trim();
          pathPart = pathPart.replace(/^["']|["']$/g, '');
          return pathPart;
        }
      }
    }
    return '';
  }, [editorContent]);

  // Extract simpleSkin path from editor content
  const extractSimpleSkinPath = useCallback(() => {
    if (!editorContent) return '';
    const lines = editorContent.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.toLowerCase().startsWith('simpleskin:')) {
        const parts = trimmedLine.split('=');
        if (parts.length >= 2) {
          let pathPart = parts[1].trim();
          pathPart = pathPart.replace(/^["']|["']$/g, '');
          return pathPart;
        }
      }
    }
    return '';
  }, [editorContent]);

  // Auto-populate material overrides from SKN
  const autoPopulateMaterials = async () => {
    if (!editorContent || !filePath) {
      setMaterialOverrideStatus('No file loaded');
      return;
    }

    const simpleSkinPath = extractSimpleSkinPath();
    if (!simpleSkinPath) {
      setMaterialOverrideStatus('simpleSkin not found in file');
      return;
    }

    const texturePath = extractTexturePath();
    if (!texturePath) {
      setMaterialOverrideStatus('texture path not found in file');
      return;
    }

    setAutoMaterialLoading(true);
    setMaterialOverrideStatus('Reading SKN...');

    try {
      // Load match mode preference (1=fuzzy, 2=loose, 3=exact)
      const matchModeStr = await invoke<string>('get_preference', {
        key: 'MaterialMatchMode',
        defaultValue: '3',
      });
      const matchMode = parseInt(matchModeStr) || 3;

      const result = await invoke<AutoMaterialResult>('auto_material_override', {
        binFilePath: filePath,
        simpleSkinPath,
        texturePath,
        matchMode,
      });

      const totalMaterials = result.matches.length + result.unmatched.length;

      if (result.matches.length === 0) {
        setMaterialOverrideStatus(
          `Matches: 0/${totalMaterials} — insert manually`
        );
        setAutoMaterialLoading(false);
        return;
      }

      // Find which materials are already present in overrides
      const existingSubmeshes = new Set<string>();
      const lines = editorContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.toLowerCase().startsWith('submesh:')) {
          const parts = trimmed.split('=');
          if (parts.length >= 2) {
            const val = parts[1].trim().replace(/^["']|["']$/g, '');
            existingSubmeshes.add(val.toLowerCase());
          }
        }
      }

      // Filter out already-present materials
      const newMatches = result.matches.filter(
        m => !existingSubmeshes.has(m.material.toLowerCase())
      );

      if (newMatches.length === 0) {
        setMaterialOverrideStatus(`Matches: ${result.matches.length}/${totalMaterials} — all already present`);
        setAutoMaterialLoading(false);
        return;
      }

      // Ensure materialOverride structure exists, then insert entries
      let content = editorContent;
      if (!content.includes('materialOverride:')) {
        const contentLines = content.split('\n');
        const newLines: string[] = [];
        let added = false;
        for (let i = 0; i < contentLines.length; i++) {
          newLines.push(contentLines[i]);
          if (!added && contentLines[i].includes('skinMeshProperties:') &&
              contentLines[i].includes('embed') &&
              contentLines[i].includes('SkinMeshDataProperties')) {
            let indent = '        ';
            if (i + 1 < contentLines.length) {
              const match = contentLines[i + 1].match(/^(\s*)/);
              if (match) indent = match[1];
            }
            newLines.push(`${indent}materialOverride: list[embed] = {`);
            newLines.push(`${indent}}`);
            added = true;
          }
        }
        content = newLines.join('\n');
      }

      // Now insert entries before closing brace of materialOverride
      const contentLines = content.split('\n');
      let matOverrideIdx = -1;
      for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i].includes('materialOverride:') && contentLines[i].includes('list[embed]')) {
          matOverrideIdx = i;
          break;
        }
      }

      if (matOverrideIdx === -1) {
        setMaterialOverrideStatus('materialOverride structure not found');
        setAutoMaterialLoading(false);
        return;
      }

      // Find closing brace
      let braceDepth = 0;
      let insertIdx = -1;
      for (let j = matOverrideIdx; j < contentLines.length; j++) {
        for (const c of contentLines[j]) {
          if (c === '{') braceDepth++;
          else if (c === '}') braceDepth--;
        }
        if (braceDepth === 0 && j > matOverrideIdx) {
          insertIdx = j;
          break;
        }
      }

      if (insertIdx === -1) {
        setMaterialOverrideStatus('Could not find closing brace');
        setAutoMaterialLoading(false);
        return;
      }

      // Get indent
      let indent = '            ';
      if (matOverrideIdx + 1 < contentLines.length && contentLines[matOverrideIdx + 1].trim()) {
        const match = contentLines[matOverrideIdx + 1].match(/^(\s*)/);
        if (match) indent = match[1];
      }

      // Build entries
      const entryLines: string[] = [];
      for (const m of newMatches) {
        entryLines.push(`${indent}SkinMeshDataProperties_MaterialOverride {`);
        entryLines.push(`${indent}    texture: string = "${m.texture}"`);
        entryLines.push(`${indent}    Submesh: string = "${m.material}"`);
        entryLines.push(`${indent}}`);
      }

      // Insert before closing brace
      const finalLines = [
        ...contentLines.slice(0, insertIdx),
        ...entryLines,
        ...contentLines.slice(insertIdx),
      ];

      onContentChange(finalLines.join('\n'));

      setMaterialOverrideStatus(
        `Matches: ${result.matches.length}/${totalMaterials} — added ${newMatches.length}`
      );
      setMaterialOverrideExists(true);
    } catch (err) {
      setMaterialOverrideStatus(`Error: ${err}`);
    } finally {
      setAutoMaterialLoading(false);
    }
  };

  // Ref for debouncing content parsing
  const parseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastParsedContentRef = useRef<string>('');

  // Load values when panel opens or content changes (DEBOUNCED to prevent memory leak)
  useEffect(() => {
    if (!isOpen) return;
    
    // Clear any pending parse
    if (parseTimeoutRef.current) {
      clearTimeout(parseTimeoutRef.current);
      parseTimeoutRef.current = null;
    }

    // Skip if content hasn't actually changed
    const contentKey = editorContent ? `${editorContent.length}-${editorContent.charCodeAt(0) || 0}-${editorContent.charCodeAt(editorContent.length - 1) || 0}` : '';
    if (contentKey === lastParsedContentRef.current) {
      return;
    }

    // Debounce parsing - wait 300ms after content changes
    parseTimeoutRef.current = setTimeout(() => {
      loadSkinScaleValue();
      checkMaterialOverride();
      setDefaultTexturePath(extractTexturePath());
      lastParsedContentRef.current = contentKey;
    }, 300);

    return () => {
      if (parseTimeoutRef.current) {
        clearTimeout(parseTimeoutRef.current);
        parseTimeoutRef.current = null;
      }
    };
  }, [isOpen, editorContent, loadSkinScaleValue, checkMaterialOverride, extractTexturePath]);

  // Handle percentage change
  const handlePercentageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const percentText = e.target.value;
    setPercentageValue(percentText);
    
    if (isUpdatingFromPercentage.current) return;
    
    const percentage = parseFloat(percentText);
    if (!isNaN(percentage)) {
      const newValue = originalSkinScale * (percentage / 100.0);
      isUpdatingFromPercentage.current = true;
      setSkinScaleValue(newValue.toFixed(2));
      isUpdatingFromPercentage.current = false;
    }
  };

  // Handle skinScale value change
  const handleSkinScaleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSkinScaleValue(e.target.value);
    
    const parsedValue = parseFloat(e.target.value);
    if (!isNaN(parsedValue) && originalSkinScale !== 0) {
      const percentage = (parsedValue / originalSkinScale) * 100;
      setPercentageValue(percentage.toFixed(0));
    }
  };

  // Apply skinScale value
  const applySkinScale = () => {
    if (!editorContent) {
      setSkinScaleStatus('No file loaded');
      return;
    }

    const newValue = skinScaleValue.trim();
    if (!newValue) {
      setSkinScaleStatus('Please enter a value');
      return;
    }

    const lines = editorContent.split('\n');
    let found = false;
    let newLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim().toLowerCase();
      
      if (trimmedLine.startsWith('skinscale:')) {
        // Find colon position in original line
        const colonIndex = line.indexOf(':');
        const afterColon = line.substring(colonIndex + 1).trim();
        
        let newLineText: string;
        if (afterColon.includes('=')) {
          // Format: skinScale: f32 = 1.15
          const equalsIndex = line.indexOf('=', colonIndex);
          const beforeEquals = line.substring(0, equalsIndex + 1);
          newLineText = beforeEquals + ' ' + newValue;
        } else {
          // Format: skinScale: 1.15
          const prefix = line.substring(0, colonIndex + 1);
          newLineText = prefix + ' ' + newValue;
        }
        
        newLines.push(newLineText);
        found = true;
      } else {
        newLines.push(line);
      }
    }

    if (found) {
      onContentChange(newLines.join('\n'));
      setSkinScaleStatus(`Applied: ${newValue}`);
      
      // Update original value for percentage calculations
      const parsedValue = parseFloat(newValue);
      if (!isNaN(parsedValue)) {
        setOriginalSkinScale(parsedValue);
        setPercentageValue('100');
      }
    } else {
      setSkinScaleStatus('skinScale not found');
    }
  };

  // Add skinScale property
  const addSkinScale = () => {
    if (!editorContent) {
      setSkinScaleStatus('No file loaded');
      return;
    }

    let newValue = skinScaleValue.trim();
    if (!newValue) {
      newValue = '1.0';
    }

    const lines = editorContent.split('\n');
    let newLines: string[] = [];
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      newLines.push(line);
      
      // Look for skinMeshProperties line
      if (line.includes('skinMeshProperties:') && 
          line.includes('embed') && 
          line.includes('SkinMeshDataProperties')) {
        // Get indentation from next line or use default
        let indent = '        ';
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const match = nextLine.match(/^(\s*)/);
          if (match) {
            indent = match[1];
          }
        }
        
        // Insert skinScale line after skinMeshProperties
        newLines.push(`${indent}skinScale: f32 = ${newValue}`);
        found = true;
      }
    }

    if (found) {
      onContentChange(newLines.join('\n'));
      setSkinScaleStatus(`Added skinScale: ${newValue}`);
      setSkinScaleExists(true);
      
      const parsedValue = parseFloat(newValue);
      if (!isNaN(parsedValue)) {
        setOriginalSkinScale(parsedValue);
        setPercentageValue('100');
      }
    } else {
      setSkinScaleStatus('skinMeshProperties not found');
    }
  };

  // Add materialOverride structure
  const addMaterialOverride = () => {
    if (!editorContent) {
      setMaterialOverrideStatus('No file loaded');
      return;
    }

    const lines = editorContent.split('\n');
    let newLines: string[] = [];
    let found = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      newLines.push(line);
      
      // Look for skinMeshProperties line
      if (line.includes('skinMeshProperties:') && 
          line.includes('embed') && 
          line.includes('SkinMeshDataProperties')) {
        // Get indentation from next line or use default
        let indent = '        ';
        if (i + 1 < lines.length) {
          const nextLine = lines[i + 1];
          const match = nextLine.match(/^(\s*)/);
          if (match) {
            indent = match[1];
          }
        }
        
        // Insert materialOverride structure after skinMeshProperties
        newLines.push(`${indent}materialOverride: list[embed] = {`);
        newLines.push(`${indent}}`);
        found = true;
      }
    }

    if (found) {
      onContentChange(newLines.join('\n'));
      setMaterialOverrideStatus('materialOverride added');
      setMaterialOverrideExists(true);
    } else {
      setMaterialOverrideStatus('skinMeshProperties not found');
    }
  };

  // Add material override entry
  const addMaterialOverrideEntry = (path: string, submesh: string, entryType: 'texture' | 'material') => {
    if (!editorContent) {
      setMaterialOverrideStatus('No file loaded');
      return;
    }

    const lines = editorContent.split('\n');
    let newLines: string[] = [];
    let materialOverrideLineIndex = -1;
    
    // Find the materialOverride line
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('materialOverride:') && lines[i].includes('list[embed]')) {
        materialOverrideLineIndex = i;
        break;
      }
    }
    
    if (materialOverrideLineIndex === -1) {
      setMaterialOverrideStatus('materialOverride structure not found');
      return;
    }

    // Find the closing brace by tracking brace depth
    let braceDepth = 0;
    let insertLineIndex = -1;
    
    for (let j = materialOverrideLineIndex; j < lines.length; j++) {
      const currentLine = lines[j];
      for (const c of currentLine) {
        if (c === '{') braceDepth++;
        else if (c === '}') braceDepth--;
      }
      
      // When we get back to depth 0, we found the closing brace
      if (braceDepth === 0 && j > materialOverrideLineIndex) {
        insertLineIndex = j;
        break;
      }
    }
    
    if (insertLineIndex === -1) {
      setMaterialOverrideStatus('Could not find closing brace');
      return;
    }

    // Get indentation
    let indent = '            ';
    if (materialOverrideLineIndex + 1 < lines.length) {
      const nextLine = lines[materialOverrideLineIndex + 1];
      if (nextLine.trim()) {
        const match = nextLine.match(/^(\s*)/);
        if (match) {
          indent = match[1];
        }
      }
    }

    // Create the entry text
    const propertyType = entryType === 'texture' ? 'string' : 'link';
    const propertyName = entryType === 'texture' ? 'texture' : 'material';
    
    const entryLines = [
      `${indent}SkinMeshDataProperties_MaterialOverride {`,
      `${indent}    ${propertyName}: ${propertyType} = "${path}"`,
      `${indent}    Submesh: string = "${submesh}"`,
      `${indent}}`
    ];

    // Build new content
    for (let i = 0; i < lines.length; i++) {
      if (i === insertLineIndex) {
        // Insert entry before closing brace
        newLines.push(...entryLines);
      }
      newLines.push(lines[i]);
    }

    onContentChange(newLines.join('\n'));
    setMaterialOverrideStatus(`Added ${entryType} entry`);
  };

  // Open material dialog — fetch SKN suggestions for unused materials
  const openMaterialDialog = async (type: 'texture' | 'material') => {
    setMaterialDialogType(type);
    setDefaultTexturePath(extractTexturePath());
    setDialogSuggestions([]);
    setDialogTextures([]);
    setShowMaterialDialog(true);

    // Try to load suggestions from SKN in the background
    if (filePath) {
      const simpleSkinPath = extractSimpleSkinPath();
      const texturePath = extractTexturePath();
      if (simpleSkinPath && texturePath) {
        try {
          const matchModeStr = await invoke<string>('get_preference', {
            key: 'MaterialMatchMode',
            defaultValue: '3',
          });
          const matchMode = parseInt(matchModeStr) || 3;
          const result = await invoke<AutoMaterialResult>('auto_material_override', {
            binFilePath: filePath,
            simpleSkinPath,
            texturePath,
            matchMode,
          });

          // Find already-present submeshes
          const existingSubmeshes = new Set<string>();
          const lines = editorContent.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().startsWith('submesh:')) {
              const parts = trimmed.split('=');
              if (parts.length >= 2) {
                const val = parts[1].trim().replace(/^["']|["']$/g, '');
                existingSubmeshes.add(val.toLowerCase());
              }
            }
          }

          // Build suggestions: matched materials first, then unmatched
          const suggestions: { material: string; texture: string }[] = [];
          for (const m of result.matches) {
            if (!existingSubmeshes.has(m.material.toLowerCase())) {
              suggestions.push({ material: m.material, texture: m.texture });
            }
          }
          for (const u of result.unmatched) {
            if (!existingSubmeshes.has(u.toLowerCase())) {
              suggestions.push({ material: u, texture: '' });
            }
          }
          setDialogSuggestions(suggestions);
          setDialogTextures(result.textures ?? []);
        } catch {
          // Silently fall back to no suggestions
        }
      }
    }
  };

  // Handle material dialog submit
  const handleMaterialDialogSubmit = (path: string, submesh: string) => {
    addMaterialOverrideEntry(path, submesh, materialDialogType);
    setShowMaterialDialog(false);
  };

  // Handle material dialog submit when a library material was paired.
  // Inserts BOTH the override entry and the full StaticMaterialDef snippet,
  // and runs SKN-based user slot resolution to fill in placeholder paths.
  const handleMaterialDialogSubmitWithLibrary = async (
    _overridePath: string, // ignored — the library material's name is used instead
    submesh: string,
    library: { materialId: string; materialPath: string; materialName: string; texture?: string }
  ) => {
    setShowMaterialDialog(false);
    setMaterialOverrideStatus(`Inserting ${library.materialName}…`);

    try {
      // 1. Load the cached snippet (with ritobin text)
      type UserSlot = { name: string; kind: string; description: string };
      type MaterialSnippet = {
        id: string;
        name: string;
        materialName: string;
        userSlots: UserSlot[];
        snippet: string;
      };
      const snippet = await invoke<MaterialSnippet | null>(
        'library_get_cached_material',
        { path: library.materialPath }
      );
      if (!snippet) {
        setMaterialOverrideStatus(`Library material ${library.materialPath} not cached`);
        return;
      }

      // 2. Auto-increment material name if jadelib_<id> already exists in the bin
      const baseName = snippet.materialName;
      const escapedBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const existingRe = new RegExp(`"${escapedBase}(?:_\\d+)?"\\s*=`, 'g');
      const existingNames = new Set<string>();
      let m: RegExpExecArray | null;
      while ((m = existingRe.exec(editorContent)) !== null) {
        // Pull the actual matched name out of the leading quote
        const nameMatch = m[0].match(/"([^"]+)"/);
        if (nameMatch) existingNames.add(nameMatch[1]);
      }
      let finalName = baseName;
      if (existingNames.has(finalName)) {
        let suffix = 2;
        while (existingNames.has(`${baseName}_${suffix}`)) suffix++;
        finalName = `${baseName}_${suffix}`;
      }

      // 3. Build the snippet text with the (possibly incremented) name
      let snippetText = snippet.snippet;
      if (finalName !== baseName) {
        const escBase = baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        snippetText = snippetText.replace(
          new RegExp(`"${escBase}"`, 'g'),
          `"${finalName}"`
        );
      }

      // 4. Replace the Diffuse_Texture placeholder with the texture path
      // from the dialog. The user picks a submesh → its texture auto-fills
      // the Texture field → that value replaces the first YOURCHAMP
      // placeholder in the snippet (the Diffuse_Texture sampler).
      if (library.texture) {
        // Replace the first texturePath containing YOURCHAMP with the
        // user-provided texture. Only the first match (Diffuse_Texture)
        // is replaced; secondary samplers (e.g. ToonShadingTex) keep
        // their paths since those are material-specific assets.
        const placeholderRe = /(texturePath:\s*string\s*=\s*")[^"]*YOURCHAMP[^"]*(")/;
        snippetText = snippetText.replace(
          placeholderRe,
          `$1${library.texture}$2`
        );
      } else if (filePath) {
        // Fallback: SKN-based auto-resolve when no texture was provided
        const simpleSkinPath = extractSimpleSkinPath();
        const texturePath = extractTexturePath();
        if (simpleSkinPath && texturePath) {
          try {
            const matchModeStr = await invoke<string>('get_preference', {
              key: 'MaterialMatchMode',
              defaultValue: '3',
            });
            const matchMode = parseInt(matchModeStr) || 3;
            const result = await invoke<AutoMaterialResult>('auto_material_override', {
              binFilePath: filePath,
              simpleSkinPath,
              texturePath,
              matchMode,
            });

            const submeshLower = submesh.toLowerCase();
            const matched = result.matches.find(
              (mm) => mm.material.toLowerCase() === submeshLower
            );

            if (matched && matched.texture) {
              const fallbackRe = /(texturePath:\s*string\s*=\s*")[^"]*YOURCHAMP[^"]*(")/g;
              snippetText = snippetText.replace(
                fallbackRe,
                `$1${matched.texture}$2`
              );
            }
          } catch (e) {
            console.warn('SKN auto-resolve failed:', e);
          }
        }
      }

      // 5. Build the final content with BOTH the override entry and the
      // StaticMaterialDef in a single update so Ctrl+Z collapses them as
      // one undo step.
      let content = editorContent;
      content = applyOverrideEntry(content, finalName, submesh, 'material');
      content = injectMaterialDefSnippet(content, snippetText);

      onContentChange(content);

      // 6. Copy the library material's textures into the user's mod folder
      //    at assets/jadelib/<id>/<filename> so the paths embedded in the
      //    snippet actually resolve to files on disk. Without this step,
      //    the bin references paths like assets/jadelib/toon-shading/
      //    ToonShading.tex but nothing is there, and the game falls back
      //    to a missing-texture placeholder.
      try {
        const modInfo = await invoke<{ mod_root: string | null }>(
          'library_detect_mod_folder',
          { binPath: filePath }
        );
        if (modInfo.mod_root) {
          const copied = await invoke<string[]>('library_copy_textures_to_mod', {
            materialPath: library.materialPath,
            modRoot: modInfo.mod_root,
          });
          // Record the insert so the parent can offer cleanup if the user
          // closes the bin without saving.
          if (filePath) onLibraryInsert?.(filePath, modInfo.mod_root, snippet.id);
          setMaterialOverrideStatus(
            `Inserted ${finalName} · copied ${copied.length} texture${copied.length === 1 ? '' : 's'} to assets/jadelib/${snippet.id}/`
          );
        } else {
          setMaterialOverrideStatus(
            `Inserted ${finalName} — couldn't find a mod root (need META/info.json, a WAD/ folder, or DATA + ASSETS siblings). Textures not copied.`
          );
        }
      } catch (e) {
        console.warn('Texture copy failed:', e);
        setMaterialOverrideStatus(`Inserted ${finalName} (texture copy failed: ${e})`);
      }
      setMaterialOverrideExists(true);
    } catch (e) {
      console.error('Library insert failed:', e);
      setMaterialOverrideStatus(`Error: ${e}`);
    }
  };

  // Pure helper: insert a SkinMeshDataProperties_MaterialOverride entry into
  // the materialOverride list and return the new content. Mirrors
  // addMaterialOverrideEntry's logic but works on a parameter instead of
  // calling onContentChange.
  const applyOverrideEntry = (
    content: string,
    path: string,
    submesh: string,
    entryType: 'texture' | 'material'
  ): string => {
    let lines = content.split('\n');

    // Ensure materialOverride structure exists
    if (!content.includes('materialOverride:')) {
      const newLines: string[] = [];
      let added = false;
      for (let i = 0; i < lines.length; i++) {
        newLines.push(lines[i]);
        if (
          !added &&
          lines[i].includes('skinMeshProperties:') &&
          lines[i].includes('embed') &&
          lines[i].includes('SkinMeshDataProperties')
        ) {
          let indent = '        ';
          if (i + 1 < lines.length) {
            const m2 = lines[i + 1].match(/^(\s*)/);
            if (m2) indent = m2[1];
          }
          newLines.push(`${indent}materialOverride: list[embed] = {`);
          newLines.push(`${indent}}`);
          added = true;
        }
      }
      lines = newLines;
    }

    let matIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('materialOverride:') && lines[i].includes('list[embed]')) {
        matIdx = i;
        break;
      }
    }
    if (matIdx === -1) return content;

    let braceDepth = 0;
    let insertIdx = -1;
    for (let j = matIdx; j < lines.length; j++) {
      for (const c of lines[j]) {
        if (c === '{') braceDepth++;
        else if (c === '}') braceDepth--;
      }
      if (braceDepth === 0 && j > matIdx) {
        insertIdx = j;
        break;
      }
    }
    if (insertIdx === -1) return content;

    let indent = '            ';
    if (matIdx + 1 < lines.length && lines[matIdx + 1].trim()) {
      const m2 = lines[matIdx + 1].match(/^(\s*)/);
      if (m2) indent = m2[1];
    }

    const propType = entryType === 'texture' ? 'string' : 'link';
    const propName = entryType === 'texture' ? 'texture' : 'material';
    const entryLines = [
      `${indent}SkinMeshDataProperties_MaterialOverride {`,
      `${indent}    ${propName}: ${propType} = "${path}"`,
      `${indent}    Submesh: string = "${submesh}"`,
      `${indent}}`,
    ];

    const out: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (i === insertIdx) out.push(...entryLines);
      out.push(lines[i]);
    }
    return out.join('\n');
  };

  // Inject a StaticMaterialDef snippet text into the top-level entries map.
  // Strategy: find the line matching `entries: map[hash,pointer] = {` and
  // insert the snippet right after it (or before the first existing entry).
  const injectMaterialDefSnippet = (content: string, snippetText: string): string => {
    const lines = content.split('\n');

    // Find the closing brace of skinMeshProperties and insert after it.
    // Track brace depth starting from the skinMeshProperties line.
    let smpStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/skinMeshProperties\s*:/.test(lines[i]) && lines[i].includes('{')) {
        smpStart = i;
        break;
      }
    }

    let insertIdx = -1;
    if (smpStart !== -1) {
      let depth = 0;
      for (let i = smpStart; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        if (depth <= 0) {
          insertIdx = i + 1;
          break;
        }
      }
    }

    // If there are already jadelib_* StaticMaterialDef entries in the file,
    // append this new one AFTER the last one so newer inserts stack below.
    // Otherwise fall back to inserting right after skinMeshProperties.
    if (insertIdx !== -1) {
      const jadelibStart = /^\s*"jadelib_[^"]*"\s*=\s*StaticMaterialDef\s*\{/;
      let lastJadelibEnd = -1;
      let i = insertIdx;
      while (i < lines.length) {
        if (jadelibStart.test(lines[i])) {
          // Walk to this block's closing brace
          let depth = 0;
          for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) {
              if (ch === '{') depth++;
              else if (ch === '}') depth--;
            }
            if (depth <= 0) {
              lastJadelibEnd = j + 1;
              i = j + 1;
              break;
            }
          }
          if (lastJadelibEnd === -1) break; // malformed — bail
        } else {
          i++;
        }
      }
      if (lastJadelibEnd !== -1) insertIdx = lastJadelibEnd;
    }

    if (insertIdx === -1) {
      // Fallback: try inserting after entries: map[hash,pointer] = {
      for (let i = 0; i < lines.length; i++) {
        if (/entries\s*:\s*map\s*\[\s*hash\s*,\s*pointer\s*\]\s*=\s*\{/.test(lines[i])) {
          insertIdx = i + 1;
          break;
        }
      }
    }

    if (insertIdx === -1) {
      return content + '\n' + snippetText + '\n';
    }

    // Match indent of the entries around skinMeshProperties (top-level entry indent)
    let indent = '    ';
    if (smpStart !== -1) {
      // Use the indent of the line containing skinMeshProperties' parent entry
      for (let i = smpStart - 1; i >= 0; i--) {
        if (/^\s*("([^"]+)"|0x[0-9a-fA-F]+)\s*=\s*\w+\s*\{/.test(lines[i])) {
          const m2 = lines[i].match(/^(\s*)/);
          if (m2) indent = m2[1];
          break;
        }
      }
    }

    const indentedSnippet = snippetText
      .split('\n')
      .map((l) => (l.length > 0 ? indent + l : l))
      .join('\n');

    return [
      ...lines.slice(0, insertIdx),
      indentedSnippet,
      ...lines.slice(insertIdx),
    ].join('\n');
  };

  if (!isRendered) return null;

  return (
    <>
      <div className="general-edit-panel-wrapper">
        <div
          className={`general-edit-panel ${isVisible ? 'visible' : ''}`}
          style={{ right: panelRight }}
        >
          <div className="gep-left-bar" />
          <div className="gep-header">
            <span className="gep-title">General Editing</span>
            <button
              className="gep-close-btn"
              onClick={onClose}
              aria-label="Close (Escape)"
            >
            </button>
          </div>
          <div className="gep-divider" />
          
          {/* SkinScale Section */}
          <div className="gep-section">
            <div 
              className="gep-section-header"
              onClick={() => setSkinScaleCollapsed(!skinScaleCollapsed)}
            >
              <span className={`gep-collapse-icon ${skinScaleCollapsed ? 'collapsed' : ''}`} />
              <span className="gep-section-title">Skin Scale</span>
            </div>
            
            {!skinScaleCollapsed && (
              <div className="gep-section-content">
                <div className="gep-row">
                  <div className="gep-input-group">
                    <input
                      type="text"
                      className="gep-input gep-input-value"
                      value={skinScaleValue}
                      onChange={handleSkinScaleChange}
                      placeholder="1.0"
                      title="SkinScale value"
                    />
                  </div>
                  <div className="gep-input-group gep-percent-group">
                    <input
                      type="text"
                      className="gep-input gep-input-percent"
                      value={percentageValue}
                      onChange={handlePercentageChange}
                      placeholder="100"
                      title="Percentage of original value"
                    />
                    <span className="gep-percent-sign">%</span>
                  </div>
                  {skinScaleExists ? (
                    <button
                      className="gep-btn gep-btn-apply"
                      onClick={applySkinScale}
                      title="Apply skinScale value"
                    >
                      <span className="gep-icon-check" />
                    </button>
                  ) : (
                    <button
                      className="gep-btn gep-btn-add"
                      onClick={addSkinScale}
                      title="Add skinScale to file"
                    >
                      <span className="gep-icon-add" />
                    </button>
                  )}
                </div>
                {skinScaleStatus && (
                  <div className="gep-status">{skinScaleStatus}</div>
                )}
              </div>
            )}
          </div>

          <div className="gep-divider" />

          {/* Material Override Section */}
          <div className="gep-section">
            <div 
              className="gep-section-header"
              onClick={() => setMaterialOverrideCollapsed(!materialOverrideCollapsed)}
            >
              <span className={`gep-collapse-icon ${materialOverrideCollapsed ? 'collapsed' : ''}`} />
              <span className="gep-section-title">Material Override</span>
            </div>
            
            {!materialOverrideCollapsed && (
              <div className="gep-section-content">
                {!materialOverrideExists ? (
                  <div className="gep-row">
                    <button
                      className="gep-btn gep-btn-full"
                      onClick={addMaterialOverride}
                      title="Add materialOverride structure"
                    >
                      <span className="gep-icon-add" />
                      <span>Add materialOverride</span>
                    </button>
                  </div>
                ) : (
                  <div className="gep-row gep-row-buttons">
                    <button
                      className="gep-btn gep-btn-half"
                      onClick={() => openMaterialDialog('texture')}
                      title="Add texture override entry"
                    >
                      <span className="gep-icon-texture" />
                      <span>Texture</span>
                    </button>
                    <button
                      className="gep-btn gep-btn-half"
                      onClick={() => openMaterialDialog('material')}
                      title="Add material override entry"
                    >
                      <span className="gep-icon-material" />
                      <span>Material</span>
                    </button>
                    <button
                      className="gep-btn gep-btn-half"
                      onClick={autoPopulateMaterials}
                      disabled={autoMaterialLoading || !filePath}
                      title="Auto-populate overrides from SKN materials"
                    >
                      <span className="gep-icon-auto" />
                      <span>{autoMaterialLoading ? 'Reading...' : 'Auto'}</span>
                    </button>
                  </div>
                )}
                {materialOverrideStatus && (
                  <div className="gep-status">{materialOverrideStatus}</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {showMaterialDialog && (
        <MaterialOverrideDialog
          type={materialDialogType}
          defaultPath={defaultTexturePath}
          onSubmit={handleMaterialDialogSubmit}
          onSubmitWithLibrary={handleMaterialDialogSubmitWithLibrary}
          onCancel={() => setShowMaterialDialog(false)}
          suggestions={dialogSuggestions}
          detectedTextures={dialogTextures}
          binFilePath={filePath}
        />
      )}
    </>
  );
}
