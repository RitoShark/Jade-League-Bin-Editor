import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';

export interface BinInfo {
  success: boolean;
  message: string;
  data?: string;
}

/**
 * Opens a file dialog and reads a .bin file, converting it to text format
 */
export async function openBinFile(): Promise<{ path: string; content: string } | null> {
  try {
    // Open file dialog
    const filePath = await open({
      filters: [
        {
          name: 'Binary Files',
          extensions: ['bin']
        },
        {
          name: 'All Files',
          extensions: ['*']
        }
      ],
      multiple: false,
    });

    if (!filePath) {
      return null;
    }

    const result = await invoke<BinInfo>('convert_bin_to_text', {
      inputPath: filePath,
    });

    if (!result.success || !result.data) {
      throw new Error(result.message || 'Failed to read bin file');
    }

    return {
      path: filePath as string,
      content: result.data
    };
  } catch (error) {
    console.error('Error opening bin file:', error);
    throw error;
  }
}

/**
 * Saves the current text content as a .bin file
 */
export async function saveBinFile(content: string, currentPath?: string): Promise<string | null> {
  try {
    let filePath: string | null;

    if (currentPath) {
      // Save to existing file
      filePath = currentPath;
    } else {
      // Show save dialog
      filePath = await save({
        filters: [
          {
            name: 'Binary Files',
            extensions: ['bin']
          }
        ],
        defaultPath: 'output.bin'
      });
    }

    if (!filePath) {
      return null;
    }

    // Convert text to bin using C# logic
    const result = await invoke<BinInfo>('convert_text_to_bin', {
      textContent: content,
      outputPath: filePath
    });

    if (!result.success) {
      throw new Error(result.message || 'Failed to save bin file');
    }

    return filePath;
  } catch (error) {
    console.error('Error saving bin file:', error);
    throw error;
  }
}

/**
 * Saves the current content to a new file (Save As)
 */
export async function saveBinFileAs(content: string): Promise<string | null> {
  return saveBinFile(content, undefined);
}

/**
 * Read a bin file directly (without file dialog)
 */
export async function readBinDirect(filePath: string): Promise<string> {
  try {
    const result = await invoke<BinInfo>('convert_bin_to_text', {
      inputPath: filePath,
    });

    if (!result.success || !result.data) {
      throw new Error(result.message || 'Failed to read bin file');
    }

    return result.data;
  } catch (error) {
    console.error('Error reading bin file:', error);
    throw error;
  }
}

/**
 * Write a bin file directly (without file dialog)
 */
export async function writeBinDirect(content: string, outputPath: string): Promise<void> {
  try {
    const result = await invoke<BinInfo>('convert_text_to_bin', {
      textContent: content,
      outputPath
    });

    if (!result.success) {
      throw new Error(result.message || 'Failed to write bin file');
    }
  } catch (error) {
    console.error('Error writing bin file:', error);
    throw error;
  }
}

// ── Plain-text formats ────────────────────────────────────────────────
//
// Jade's editor can also open and save regular text files (txt, json,
// md, etc.) so the user can keep notes / scratch work / exported JSON
// inside the same window. We don't register these as a file association
// — Jade is still primarily a .bin editor — but the editor pane will
// happily host them.
//
// The .py extension is treated as ritobin source (sidecar workflow),
// not as Python, and stays on the bin pipeline.

const PLAIN_TEXT_EXTENSIONS = new Set([
  'txt', 'json', 'md', 'markdown', 'xml', 'yaml', 'yml', 'ini', 'toml',
  'csv', 'tsv', 'log', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts',
  'tsx', 'jsx', 'sh', 'bat', 'cmd', 'ps1', 'sql', 'env', 'conf', 'cfg',
  'gitignore', 'gitattributes',
]);

/** Returns the lowercase extension without the dot, or '' for none. */
export function getFileExtension(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  if (dot <= slash) return '';
  return path.slice(dot + 1).toLowerCase();
}

/** True if the path should be handled by the bin converter (.bin or .py sidecar). */
export function isBinLikePath(path: string): boolean {
  const ext = getFileExtension(path);
  return ext === 'bin' || ext === 'py';
}

/** True if the path is a text format Jade will open as plain text. */
export function isPlainTextPath(path: string): boolean {
  const ext = getFileExtension(path);
  if (!ext) return true; // extension-less files: assume text
  return PLAIN_TEXT_EXTENSIONS.has(ext);
}

/** Read a file as raw UTF-8 text (no bin conversion). */
export async function readTextDirect(filePath: string): Promise<string> {
  return invoke<string>('read_text_file', { path: filePath });
}

/** Write raw UTF-8 text to disk (no bin conversion). */
export async function writeTextDirect(content: string, outputPath: string): Promise<void> {
  await invoke('write_text_file', { path: outputPath, content });
}

/**
 * Open dialog that accepts both .bin and common plain-text formats.
 * Routes to the right reader based on the chosen file's extension.
 */
export async function openAnyEditorFile(): Promise<{ path: string; content: string } | null> {
  try {
    const filePath = await open({
      filters: [
        { name: 'Binary',   extensions: ['bin'] },
        { name: 'Text',     extensions: ['txt'] },
        { name: 'Markdown', extensions: ['md'] },
        { name: 'JSON',     extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      multiple: false,
    });
    if (!filePath) return null;

    const path = filePath as string;
    if (isBinLikePath(path)) {
      return { path, content: await readBinDirect(path) };
    }
    return { path, content: await readTextDirect(path) };
  } catch (error) {
    console.error('Error opening file:', error);
    throw error;
  }
}

/**
 * Save dialog. The format list is intentionally short — these are the
 * extensions people actually save to. The "All Files" filter still lets
 * power users pick anything else (the extension they type drives the
 * writer choice via isBinLikePath).
 */
export async function saveAnyFileAs(content: string, defaultName?: string): Promise<string | null> {
  try {
    const filePath = await save({
      filters: [
        { name: 'Binary',   extensions: ['bin'] },
        { name: 'Text',     extensions: ['txt'] },
        { name: 'Markdown', extensions: ['md'] },
        { name: 'JSON',     extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      defaultPath: defaultName ?? 'Untitled.txt',
    });
    if (!filePath) return null;

    if (isBinLikePath(filePath)) {
      await writeBinDirect(content, filePath);
    } else {
      await writeTextDirect(content, filePath);
    }
    return filePath;
  } catch (error) {
    console.error('Error saving file:', error);
    throw error;
  }
}

/** Save in-place: write to an existing path, picking writer by extension. */
export async function saveAnyFileToPath(content: string, filePath: string): Promise<void> {
  if (isBinLikePath(filePath)) {
    await writeBinDirect(content, filePath);
  } else {
    await writeTextDirect(content, filePath);
  }
}
